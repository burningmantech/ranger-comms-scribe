import { WebSocket } from 'ws';

/**
 * In-process real-time rooms.
 *
 * This replaces the Cloudflare Durable Object that used to back /api/ws/*. The
 * behavior is a plain relay, the same as before:
 *   - on join: `user_joined` to the others, `room_state` to everyone (including the
 *     new socket), then `connected` to the new socket only;
 *   - every other message is relayed to the rest of the room with the sender's
 *     identity (userId, userName, userEmail) and a `seq` stamped on;
 *   - ping -> pong, heartbeat -> heartbeat_response, client pongs are swallowed;
 *   - the server sends an app-level `ping` every 30 s;
 *   - on close: `user_left` and an updated `room_state` to the rest of the room.
 *
 * `seq` counts the broadcasts delivered to each connection (1, 2, 3, ...). The client
 * treats a jump as missed messages and refetches (`sync_needed`), so the numbers must
 * have no holes from that client's point of view. The Durable Object used one counter
 * per room, which skipped a number for every message the client itself sent; each
 * send then looked like a gap to the sender, whose refetch froze change tracking for
 * 5 s and reloaded stale content over its newest keystrokes.
 *
 * All state is in memory; the service runs as a single task (desiredCount = 1).
 *
 * Room keys: `submission:<id>` and `document:<id>`, used for both connecting and
 * broadcasting (the old Worker used `document-<id>` for broadcasts but `<id>` for
 * connections, so document broadcasts never arrived).
 */

export type WebSocketMessageType =
  | 'user_joined' | 'user_left' | 'editing_started' | 'editing_stopped' | 'content_updated'
  | 'comment_added' | 'comment_resolved' | 'approval_added' | 'status_changed' | 'error' | 'room_state' | 'connected'
  | 'heartbeat' | 'heartbeat_response' | 'ping' | 'pong' | 'cursor_position' | 'text_operation'
  | 'user_presence' | 'typing_start' | 'typing_stop' | 'realtime_content_update'
  | 'transaction_settled' | 'transaction_undone' | 'transaction_redone' | 'change_status_updated'
  | 'approval_state';

export interface RoomUser {
  userId: string;
  userName: string;
  userEmail: string;
  connectedAt: string;
}

export interface WebSocketMessage {
  type: WebSocketMessageType;
  submissionId?: string;
  documentId?: string;
  userId: string;
  userName: string;
  userEmail: string;
  data?: any;
  timestamp: string;
  users?: RoomUser[];
}

export interface RoomIdentity {
  userId: string;
  userName: string;
  userEmail: string;
}

interface ConnectionMetadata extends RoomIdentity {
  roomKey: string;
  submissionId?: string;
  documentId?: string;
  connectedAt: string;
  lastSeen: number;
  /** Broadcasts delivered to this connection; the last value stamped as `seq`. */
  seq: number;
}

export type RoomTarget = { kind: 'submission' | 'document'; id: string };

export const submissionRoomKey = (submissionId: string): string => `submission:${submissionId}`;
export const documentRoomKey = (documentId: string): string => `document:${documentId}`;
export const roomKeyFor = (target: RoomTarget): string =>
  target.kind === 'submission' ? submissionRoomKey(target.id) : documentRoomKey(target.id);

const DEFAULT_PING_INTERVAL_MS = 30000;

const rooms = new Map<string, Set<WebSocket>>();
const connections = new Map<WebSocket, ConnectionMetadata>();
const pingTimers = new Map<WebSocket, ReturnType<typeof setInterval>>();
let pingIntervalMs = DEFAULT_PING_INTERVAL_MS;

/** Override the server ping interval (tests). Applies to connections that join afterwards. */
export function setPingIntervalMs(ms: number): void {
  pingIntervalMs = ms;
}

const now = () => new Date().toISOString();

function targetIds(meta: { submissionId?: string; documentId?: string }) {
  return { submissionId: meta.submissionId, documentId: meta.documentId };
}

function safeSend(ws: WebSocket, payload: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(payload);
    return true;
  } catch (error) {
    console.error('Error sending WebSocket message:', error);
    return false;
  }
}

/**
 * Send `message` to every open socket in the room except `exclude`, stamping each
 * recipient's next `seq` (see the header: per connection, so a client never sees a
 * hole for messages it didn't need).
 */
export function broadcastToRoom(roomKey: string, message: Record<string, any>, exclude?: WebSocket): number {
  const room = rooms.get(roomKey);
  if (!room || room.size === 0) return 0;

  let sent = 0;
  for (const ws of Array.from(room)) {
    if (ws === exclude) continue;
    const meta = connections.get(ws);
    if (!meta) continue;
    // Sockets that are closing are skipped; their 'close' handler removes them
    // and announces user_left.
    if (safeSend(ws, JSON.stringify({ ...message, seq: meta.seq + 1 }))) {
      meta.seq += 1;
      sent++;
    }
  }
  return sent;
}

/** Users currently in a room, deduplicated by userId (first connection wins). */
export function getRoomUsers(roomKey: string): RoomUser[] {
  const room = rooms.get(roomKey);
  if (!room) return [];

  const users: RoomUser[] = [];
  const seen = new Set<string>();
  for (const ws of Array.from(room)) {
    const meta = connections.get(ws);
    if (!meta || ws.readyState !== WebSocket.OPEN) continue;
    if (seen.has(meta.userId)) continue;
    seen.add(meta.userId);
    users.push({
      userId: meta.userId,
      userName: meta.userName,
      userEmail: meta.userEmail,
      connectedAt: meta.connectedAt,
    });
  }
  return users;
}

function roomStateMessage(roomKey: string, ids: { submissionId?: string; documentId?: string }): WebSocketMessage {
  return {
    type: 'room_state',
    ...ids,
    userId: 'system',
    userName: 'System',
    userEmail: 'system@websocket',
    users: getRoomUsers(roomKey),
    timestamp: now(),
  };
}

/**
 * Remove a socket from its room. When `announce` is true, tell the rest of the
 * room (`user_left` then `room_state`). Safe to call more than once.
 */
function removeConnection(ws: WebSocket, announce: boolean): void {
  const timer = pingTimers.get(ws);
  if (timer) {
    clearInterval(timer);
    pingTimers.delete(ws);
  }

  const meta = connections.get(ws);
  if (!meta) return;
  connections.delete(ws);

  const room = rooms.get(meta.roomKey);
  if (room) {
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(meta.roomKey);
    }
  }

  if (announce) {
    const ids = targetIds(meta);
    broadcastToRoom(meta.roomKey, {
      type: 'user_left',
      ...ids,
      userId: meta.userId,
      userName: meta.userName,
      userEmail: meta.userEmail,
      timestamp: now(),
    } as WebSocketMessage);
    broadcastToRoom(meta.roomKey, roomStateMessage(meta.roomKey, ids));
  }
}

function handleMessage(ws: WebSocket, raw: string): void {
  const meta = connections.get(ws);
  if (!meta) {
    ws.close(1008, 'Connection metadata not found');
    return;
  }
  meta.lastSeen = Date.now();

  let message: WebSocketMessage;
  try {
    message = JSON.parse(raw);
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Message must be a JSON object');
    }
  } catch (error) {
    console.error('Error handling WebSocket message:', error);
    safeSend(ws, JSON.stringify({ type: 'error', message: 'Failed to process message', timestamp: now() }));
    return;
  }

  // Server-stamped identity: never trust what the client claims.
  message.userId = meta.userId;
  message.userName = meta.userName;
  message.userEmail = meta.userEmail;
  message.submissionId = meta.submissionId;
  message.documentId = meta.documentId;
  message.timestamp = now();

  if (message.type === 'heartbeat') {
    safeSend(ws, JSON.stringify({
      type: 'heartbeat_response',
      submissionId: meta.submissionId,
      userId: meta.userId,
      userName: meta.userName,
      userEmail: meta.userEmail,
      timestamp: now(),
    }));
    return;
  }

  if (message.type === 'ping') {
    safeSend(ws, JSON.stringify({
      type: 'pong',
      ...targetIds(meta),
      userId: meta.userId,
      userName: meta.userName,
      userEmail: meta.userEmail,
      timestamp: now(),
    }));
    return;
  }

  if (message.type === 'pong') {
    return;
  }

  broadcastToRoom(meta.roomKey, message, ws);
}

function startServerPing(ws: WebSocket): void {
  const interval = pingIntervalMs;
  const timer = setInterval(() => {
    const meta = connections.get(ws);
    if (!meta || ws.readyState !== WebSocket.OPEN) {
      removeConnection(ws, !!meta);
      return;
    }
    // Node has no runtime that notices half-open TCP connections for us (the Durable
    // Object runtime did). The client answers every server ping with a pong, so a
    // socket that has been silent for more than two intervals is dead.
    if (Date.now() - meta.lastSeen > interval * 2 + 10000) {
      ws.terminate();
      return;
    }
    safeSend(ws, JSON.stringify({
      type: 'ping',
      ...targetIds(meta),
      userId: 'server',
      userName: 'Server',
      userEmail: 'server@websocket',
      timestamp: now(),
    }));
  }, interval);
  if (typeof timer.unref === 'function') timer.unref();
  pingTimers.set(ws, timer);
}

/** Register an accepted socket in a room and run the join protocol. */
export function joinRoom(ws: WebSocket, target: RoomTarget, identity: RoomIdentity): void {
  const roomKey = roomKeyFor(target);
  const ids = target.kind === 'submission' ? { submissionId: target.id } : { documentId: target.id };

  connections.set(ws, {
    ...identity,
    ...ids,
    roomKey,
    connectedAt: now(),
    lastSeen: Date.now(),
    seq: 0,
  });
  if (!rooms.has(roomKey)) rooms.set(roomKey, new Set());
  rooms.get(roomKey)!.add(ws);

  ws.on('message', (data, isBinary) => {
    handleMessage(ws, isBinary ? '' : data.toString());
  });
  ws.on('close', () => removeConnection(ws, true));
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  broadcastToRoom(roomKey, {
    type: 'user_joined',
    ...ids,
    userId: identity.userId,
    userName: identity.userName,
    userEmail: identity.userEmail,
    timestamp: now(),
  } as WebSocketMessage, ws);

  broadcastToRoom(roomKey, roomStateMessage(roomKey, ids));

  safeSend(ws, JSON.stringify({
    type: 'connected',
    ...ids,
    userId: identity.userId,
    userName: identity.userName,
    userEmail: identity.userEmail,
    timestamp: now(),
  } as WebSocketMessage));

  startServerPing(ws);
}

/** Close every socket (e.g. on shutdown) and clear all room state. */
export function closeAllRooms(code = 1001, reason = 'Server shutting down'): void {
  for (const ws of Array.from(connections.keys())) {
    removeConnection(ws, false);
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  }
  for (const timer of pingTimers.values()) clearInterval(timer);
  pingTimers.clear();
  rooms.clear();
}

/** Number of open connections across all rooms (diagnostics). */
export function connectionCount(): number {
  return connections.size;
}
