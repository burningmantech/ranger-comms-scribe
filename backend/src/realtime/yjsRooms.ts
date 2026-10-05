import { WebSocket, RawData } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { RoomIdentity } from './rooms';

/**
 * In-process Yjs collaboration rooms for /api/ws/yjs/submissions/:submissionId
 * (contracts §9).
 *
 * Wire protocol: the standard y-websocket protocol, so the stock `y-websocket`
 * `WebsocketProvider` works as the client. Every frame is binary (lib0 encoding) and
 * starts with a varUint message type:
 *   - 0 messageSync: y-protocols/sync step 1, step 2 or update;
 *   - 1 messageAwareness: a y-protocols/awareness update;
 *   - 3 messageQueryAwareness: the client asks for every awareness state.
 * This is a TypeScript re-implementation of y-websocket's reference server logic
 * (`setupWSConnection`), plus the seeding rule below. It does not depend on
 * y-websocket's server code.
 *
 * State: one `Y.Doc` and one `Awareness` per submission, in memory (the service runs
 * as a single task). A room is destroyed `roomGraceMs` (30 s) after its last
 * connection leaves; reconnecting within that window keeps the doc.
 *
 * Exactly one bootstrap (the seeding rule). Lexical's CollaborationPlugin applies the
 * saved content (`initialEditorState`) when its doc syncs and is empty. If two
 * clients both synced against an empty server doc, both would insert the saved
 * content and the merge would contain it twice. So, while the room's doc is empty:
 *   - the first connection to join is the seeder. Its sync step 1 is answered at once
 *     (step 2, empty), followed by the server's own step 1;
 *   - every other connection is held. Its step 1 is remembered but not answered, it
 *     receives no doc updates, and its own doc messages are ignored (anything it has
 *     is collected later through the server's step 1, which it answers with step 2);
 *   - when an update makes the doc non-empty (the seed), every held connection is
 *     released: it gets step 2 computed against the state vector from its step 1,
 *     which carries the whole seed, then the server's step 1;
 *   - if the seeder leaves while the doc is still empty, the next held connection in
 *     join order becomes the seeder, and its step 1 is answered (now, or when it
 *     arrives).
 * "Non-empty" means the doc has at least one struct (`doc.store.clients.size > 0`).
 * Yjs never removes clients from the store, so once seeded a room stays seeded.
 *
 * Awareness is relayed to every connection, including the sender and held
 * connections. The echo matters: `WebsocketProvider` closes a socket that has received
 * nothing for 30 s, and a lone client's own awareness renewal (every 15 s) coming
 * back is what keeps it open. Awareness is not doc state, so held clients may get it.
 *
 * Liveness: the same dead-connection rule as rooms.ts (a socket silent for more than
 * two ping intervals plus 10 s is terminated), but the ping is a WebSocket protocol
 * ping frame. The y-websocket client decodes every message as binary, so the JSON
 * `ping` rooms.ts sends would break it; browsers answer protocol pings automatically.
 */

export const messageSync = 0;
export const messageAwareness = 1;
export const messageQueryAwareness = 3;

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_ROOM_GRACE_MS = 30_000;

let pingIntervalMs = DEFAULT_PING_INTERVAL_MS;
let roomGraceMs = DEFAULT_ROOM_GRACE_MS;

/** Override the protocol ping interval (tests). Applies to connections that join afterwards. */
export function setYjsPingIntervalMs(ms: number): void {
  pingIntervalMs = ms;
}

/** Override how long an empty room is kept before it's destroyed (tests). Applies to rooms emptied afterwards. */
export function setYjsRoomGraceMs(ms: number): void {
  roomGraceMs = ms;
}

/**
 * - `seeder`: may seed the empty doc; its step 1 is answered.
 * - `held`: joined while the doc was empty and someone else is the seeder.
 * - `synced`: normal y-websocket behavior.
 */
type ConnectionState = 'seeder' | 'held' | 'synced';

interface YjsConnection {
  ws: WebSocket;
  identity: RoomIdentity;
  state: ConnectionState;
  /** State vector from the latest step 1 not yet answered (held, or a seeder before its step 1 is answered). */
  pendingStateVector: Uint8Array | null;
  /** Whether the server has sent this connection its own step 1. */
  sentServerStep1: boolean;
  /** Awareness client IDs this connection controls; removed when it closes. */
  awarenessIds: Set<number>;
  lastSeen: number;
  pingTimer: ReturnType<typeof setInterval> | null;
}

interface YjsRoom {
  submissionId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  /** Insertion order is join order (used to pick the next seeder). */
  conns: Map<WebSocket, YjsConnection>;
  seeded: boolean;
  destroyTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, YjsRoom>();

const isEmpty = (doc: Y.Doc): boolean => doc.store.clients.size === 0;

function send(conn: YjsConnection, message: Uint8Array): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  try {
    conn.ws.send(message, (error) => {
      if (error) console.error('Error sending Yjs message:', error);
    });
  } catch (error) {
    console.error('Error sending Yjs message:', error);
  }
}

function syncStep2Message(doc: Y.Doc, stateVector: Uint8Array | undefined): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeSyncStep2(encoder, doc, stateVector);
  return encoding.toUint8Array(encoder);
}

function syncStep1Message(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

function awarenessMessage(awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageAwareness);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}

/** Send the server's step 1 once, so the client answers with whatever the server lacks. */
function sendServerStep1(room: YjsRoom, conn: YjsConnection): void {
  if (conn.sentServerStep1) return;
  conn.sentServerStep1 = true;
  send(conn, syncStep1Message(room.doc));
}

/** Answer a step 1 (state vector) with step 2: everything the client is missing. */
function answerStep1(room: YjsRoom, conn: YjsConnection, stateVector: Uint8Array): void {
  conn.pendingStateVector = null;
  send(conn, syncStep2Message(room.doc, stateVector));
  sendServerStep1(room, conn);
}

/** The doc just became non-empty: release every held connection with the full state. */
function releaseHeld(room: YjsRoom): void {
  room.seeded = true;
  for (const conn of room.conns.values()) {
    const wasHeld = conn.state === 'held';
    conn.state = 'synced';
    if (!wasHeld) continue;
    if (conn.pendingStateVector) {
      answerStep1(room, conn, conn.pendingStateVector);
    } else {
      // Its step 1 hasn't arrived; it will be answered normally when it does.
      sendServerStep1(room, conn);
    }
  }
}

/** The seeder left an empty room: the next held connection in join order seeds instead. */
function promoteNextSeeder(room: YjsRoom): void {
  for (const conn of room.conns.values()) {
    if (conn.state !== 'held') continue;
    conn.state = 'seeder';
    if (conn.pendingStateVector) answerStep1(room, conn, conn.pendingStateVector);
    return;
  }
}

function createRoom(submissionId: string): YjsRoom {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  const room: YjsRoom = { submissionId, doc, awareness, conns: new Map(), seeded: false, destroyTimer: null };

  // Relay doc updates to every connection that may see doc state, except the sender.
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    for (const conn of room.conns.values()) {
      if (conn === origin || conn.state === 'held') continue;
      send(conn, message);
    }
  });

  awareness.on('update', (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    const changed = added.concat(updated, removed);
    const sender = origin && typeof origin === 'object' && room.conns.get((origin as YjsConnection).ws) === origin
      ? origin as YjsConnection
      : null;
    if (sender) {
      added.forEach((id) => sender.awarenessIds.add(id));
      removed.forEach((id) => sender.awarenessIds.delete(id));
    }
    const message = awarenessMessage(awareness, changed);
    for (const conn of room.conns.values()) send(conn, message);
  });

  rooms.set(submissionId, room);
  return room;
}

function destroyRoom(room: YjsRoom): void {
  if (room.destroyTimer) clearTimeout(room.destroyTimer);
  room.destroyTimer = null;
  if (rooms.get(room.submissionId) === room) rooms.delete(room.submissionId);
  room.awareness.destroy(); // clears its outdated-state interval
  room.doc.destroy();
}

function scheduleDestroy(room: YjsRoom): void {
  if (room.destroyTimer) clearTimeout(room.destroyTimer);
  room.destroyTimer = setTimeout(() => {
    room.destroyTimer = null;
    if (room.conns.size === 0) destroyRoom(room);
  }, roomGraceMs);
  if (typeof room.destroyTimer.unref === 'function') room.destroyTimer.unref();
}

function removeConnection(room: YjsRoom, conn: YjsConnection): void {
  if (conn.pingTimer) {
    clearInterval(conn.pingTimer);
    conn.pingTimer = null;
  }
  if (room.conns.get(conn.ws) !== conn) return;
  room.conns.delete(conn.ws);

  if (conn.awarenessIds.size > 0) {
    awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(conn.awarenessIds), null);
  }

  if (conn.state === 'seeder' && !room.seeded) promoteNextSeeder(room);

  if (room.conns.size === 0) scheduleDestroy(room);
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function handleSyncMessage(room: YjsRoom, conn: YjsConnection, decoder: decoding.Decoder): void {
  const syncType = decoding.readVarUint(decoder);
  switch (syncType) {
    case syncProtocol.messageYjsSyncStep1: {
      const stateVector = decoding.readVarUint8Array(decoder);
      if (conn.state === 'held') {
        conn.pendingStateVector = stateVector; // answered on release (or promotion)
        return;
      }
      answerStep1(room, conn, stateVector);
      return;
    }
    case syncProtocol.messageYjsSyncStep2:
    case syncProtocol.messageYjsUpdate: {
      const update = decoding.readVarUint8Array(decoder);
      // A held client must not seed. Its state is collected after release through the
      // server's step 1, so nothing is lost by ignoring it here.
      if (conn.state === 'held') return;
      Y.applyUpdate(room.doc, update, conn);
      if (!room.seeded && !isEmpty(room.doc)) releaseHeld(room);
      return;
    }
    default:
      throw new Error(`Unknown sync message type ${syncType}`);
  }
}

function handleMessage(room: YjsRoom, conn: YjsConnection, data: RawData, isBinary: boolean): void {
  conn.lastSeen = Date.now();
  if (!isBinary) {
    conn.ws.close(1003, 'Binary frames only');
    return;
  }
  try {
    const decoder = decoding.createDecoder(toUint8Array(data));
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case messageSync:
        handleSyncMessage(room, conn, decoder);
        break;
      case messageAwareness:
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
        break;
      case messageQueryAwareness:
        send(conn, awarenessMessage(room.awareness, Array.from(room.awareness.getStates().keys())));
        break;
      default:
        // Unknown types (e.g. auth = 2, which only the server sends) are ignored, as the reference server does.
        break;
    }
  } catch (error) {
    console.error(`Error handling Yjs message for submission ${room.submissionId}:`, error);
    conn.ws.close(1007, 'Invalid Yjs message');
  }
}

function startPing(room: YjsRoom, conn: YjsConnection): void {
  const interval = pingIntervalMs;
  conn.pingTimer = setInterval(() => {
    if (conn.ws.readyState !== WebSocket.OPEN) {
      removeConnection(room, conn);
      return;
    }
    if (Date.now() - conn.lastSeen > interval * 2 + 10_000) {
      conn.ws.terminate();
      return;
    }
    try {
      conn.ws.ping();
    } catch (error) {
      console.error('Error sending Yjs ping:', error);
    }
  }, interval);
  if (typeof conn.pingTimer.unref === 'function') conn.pingTimer.unref();
}

/** Register an accepted socket in the submission's Yjs room. */
export function joinYjsRoom(ws: WebSocket, submissionId: string, identity: RoomIdentity): void {
  const room = rooms.get(submissionId) ?? createRoom(submissionId);
  if (room.destroyTimer) {
    clearTimeout(room.destroyTimer);
    room.destroyTimer = null;
  }

  let state: ConnectionState = 'synced';
  if (!room.seeded) {
    const hasSeeder = Array.from(room.conns.values()).some((c) => c.state === 'seeder');
    state = hasSeeder ? 'held' : 'seeder';
  }
  const conn: YjsConnection = {
    ws,
    identity,
    state,
    pendingStateVector: null,
    sentServerStep1: false,
    awarenessIds: new Set(),
    lastSeen: Date.now(),
    pingTimer: null,
  };
  room.conns.set(ws, conn);

  ws.binaryType = 'nodebuffer';
  ws.on('message', (data, isBinary) => handleMessage(room, conn, data, isBinary));
  ws.on('pong', () => { conn.lastSeen = Date.now(); });
  ws.on('close', () => removeConnection(room, conn));
  ws.on('error', (error) => console.error('Yjs WebSocket error:', error));

  // As the reference server does, a client joining a seeded doc gets the server's
  // step 1 right away. Seeders and held clients get it when their step 1 is answered.
  if (state === 'synced') sendServerStep1(room, conn);

  const awarenessStates = room.awareness.getStates();
  if (awarenessStates.size > 0) {
    send(conn, awarenessMessage(room.awareness, Array.from(awarenessStates.keys())));
  }

  startPing(room, conn);
}

/** Close every Yjs socket (e.g. on shutdown) and destroy all rooms. */
export function closeAllYjsRooms(code = 1001, reason = 'Server shutting down'): void {
  for (const room of Array.from(rooms.values())) {
    for (const conn of Array.from(room.conns.values())) {
      if (conn.pingTimer) clearInterval(conn.pingTimer);
      conn.pingTimer = null;
      room.conns.delete(conn.ws);
      try {
        conn.ws.close(code, reason);
      } catch {
        conn.ws.terminate();
      }
    }
    destroyRoom(room);
  }
  rooms.clear();
}

/** Diagnostics and tests: whether a room exists for the submission. */
export function hasYjsRoom(submissionId: string): boolean {
  return rooms.has(submissionId);
}

/** Diagnostics and tests: the room's server-side doc, if the room exists. */
export function getYjsRoomDoc(submissionId: string): Y.Doc | undefined {
  return rooms.get(submissionId)?.doc;
}

/** Diagnostics and tests: number of live Yjs rooms. */
export function yjsRoomCount(): number {
  return rooms.size;
}
