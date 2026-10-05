/**
 * Protocol tests for the Yjs collaboration socket (/api/ws/yjs/submissions/:id,
 * contracts §9). Starts the real Node server on an ephemeral port and talks to it
 * with:
 *   - the stock y-websocket `WebsocketProvider` (the client the frontend uses), and
 *   - `RawYClient`, a minimal client speaking the same protocol with y-protocols and
 *     `ws`, which records every frame so the seeding rule can be checked exactly.
 */
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebsocketProvider } from 'y-websocket';
import { createAppServer, AppServer, AppServerOptions } from '../../src/httpServer';
import { configureCors } from '../../src/index';
import { loadConfig } from '../../src/config/env';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { Env, CreateSession } from '../../src/utils/sessionManager';
import { saveUser } from '../../src/services/userService';
import { putObject, clearMemoryCache } from '../../src/services/cacheService';
import {
  getYjsRoomDoc,
  hasYjsRoom,
  messageAwareness,
  messageQueryAwareness,
  messageSync,
  setYjsPingIntervalMs,
  setYjsRoomGraceMs,
} from '../../src/realtime/yjsRooms';
import { User, UserType } from '../../src/types';

type Frame =
  | { kind: 'step1'; data: Uint8Array }
  | { kind: 'step2'; data: Uint8Array }
  | { kind: 'update'; data: Uint8Array }
  | { kind: 'awareness'; data: Uint8Array };

const SERVER = 'server';

/**
 * Minimal y-websocket client. Like WebsocketProvider it sends step 1 on open, answers
 * the server's step 1 with step 2, applies step 2 and updates, and sends local doc
 * updates. Every received frame is recorded.
 */
class RawYClient {
  readonly doc = new Y.Doc();
  readonly frames: Frame[] = [];
  readonly ws: WebSocket;
  private waiters: Array<() => void> = [];

  constructor(url: string, opts: { sendStep1OnOpen?: boolean } = {}) {
    const { sendStep1OnOpen = true } = opts;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('open', () => {
      if (sendStep1OnOpen) this.sendStep1();
    });
    this.ws.on('message', (data: Buffer) => this.receive(new Uint8Array(data)));
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === SERVER) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      this.sendRaw(encoding.toUint8Array(encoder));
    });
  }

  get text(): Y.Text {
    return this.doc.getText('t');
  }

  count(kind: Frame['kind']): number {
    return this.frames.filter((f) => f.kind === kind).length;
  }

  /** Frames that carry doc state from the server. */
  docFrames(): Frame[] {
    return this.frames.filter((f) => f.kind === 'step2' || f.kind === 'update');
  }

  sendStep1(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.sendRaw(encoding.toUint8Array(encoder));
  }

  sendRaw(message: Uint8Array | string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(message);
  }

  private receive(message: Uint8Array): void {
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    if (type === messageSync) {
      const syncType = decoding.readVarUint(decoder);
      const data = decoding.readVarUint8Array(decoder);
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        this.frames.push({ kind: 'step1', data });
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.writeSyncStep2(encoder, this.doc, data);
        this.sendRaw(encoding.toUint8Array(encoder));
      } else {
        this.frames.push({ kind: syncType === syncProtocol.messageYjsSyncStep2 ? 'step2' : 'update', data });
        Y.applyUpdate(this.doc, data, SERVER);
      }
    } else if (type === messageAwareness) {
      this.frames.push({ kind: 'awareness', data: decoding.readVarUint8Array(decoder) });
    }
    this.waiters.slice().forEach((wake) => wake());
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate()) return false;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== check);
        resolve();
        return true;
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== check);
        reject(new Error(`Timed out; frames: ${this.frames.map((f) => f.kind).join(',')}`));
      }, timeoutMs);
      if (!check()) this.waiters.push(check);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

/** Attempt an upgrade that should be rejected; resolve with the HTTP status. */
function expectRejected(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    ws.on('open', () => {
      ws.close();
      reject(new Error('Upgrade unexpectedly succeeded'));
    });
    ws.on('error', () => { /* reported through unexpected-response */ });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await sleep(10);
  }
}

const alice: User = {
  id: 'alice-id', email: 'alice@example.com', name: 'Alice', userType: UserType.Admin,
  approved: true, isAdmin: true, groups: [], roles: ['Admin'],
};
const bob: User = {
  id: 'bob-id', email: 'bob@example.com', name: 'Bob', userType: UserType.CommsCadre,
  approved: true, isAdmin: false, groups: [], roles: ['CommsCadre'],
};
const mallory: User = {
  id: 'mallory-id', email: 'mallory@example.com', name: 'Mallory', userType: UserType.Public,
  approved: true, isAdmin: false, groups: [], roles: ['Public'],
};

const BASE_ENV = {
  STORE_DRIVER: 'memory',
  PUBLIC_URL: 'http://localhost/api',
  FRONTEND_URL: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: 'test-client',
  TURNSTILESECRET: 'test-secret',
};

async function startServer(env: Env, options: AppServerOptions = {}): Promise<{ app: AppServer; base: string; http: string }> {
  const app = createAppServer(env, options);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

describe('Yjs collaboration socket (real sessions)', () => {
  let env: Env;
  let app: AppServer;
  let base: string;
  let httpBase: string;
  let aliceSession: string;
  let bobSession: string;
  let mallorySession: string;
  const raws: RawYClient[] = [];
  const providers: WebsocketProvider[] = [];
  let nextId = 0;

  /** A fresh submission (so each test starts with an empty room) that alice and bob may open. */
  const newSubmission = async (): Promise<string> => {
    const id = `yjs-sub-${++nextId}`;
    await putObject(`content_submissions/${id}`, {
      id, title: 'T', content: 'C', submittedBy: 'someone-else', requiredApprovers: [],
    }, env);
    return id;
  };

  const yjsUrl = (submissionId: string, sessionId: string) =>
    `${base}/api/ws/yjs/submissions/${submissionId}?sessionId=${encodeURIComponent(sessionId)}`;

  const raw = (submissionId: string, sessionId: string, opts?: { sendStep1OnOpen?: boolean }) => {
    const client = new RawYClient(yjsUrl(submissionId, sessionId), opts);
    raws.push(client);
    return client;
  };

  const provider = (submissionId: string, sessionId: string, doc = new Y.Doc()) => {
    // As the frontend will: new WebsocketProvider(wsBase + '/api/ws/yjs/submissions', id, doc, { params: { sessionId } }).
    // disableBc: Node has a global BroadcastChannel; providers in one process would
    // otherwise sync with each other directly and bypass the server.
    const p = new WebsocketProvider(`${base}/api/ws/yjs/submissions`, submissionId, doc, {
      params: { sessionId },
      WebSocketPolyfill: WebSocket as any,
      disableBc: true,
    });
    providers.push(p);
    return p;
  };

  const synced = (p: WebsocketProvider, timeoutMs = 3000): Promise<void> => new Promise((resolve, reject) => {
    if (p.synced) return resolve();
    const timer = setTimeout(() => reject(new Error('Provider did not sync')), timeoutMs);
    p.once('sync', (state: boolean) => {
      clearTimeout(timer);
      if (state) resolve();
    });
  });

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    clearMemoryCache();
    env = loadConfig(BASE_ENV, { store: new MemoryObjectStore() }).env;
    configureCors(env.CORS_ORIGINS);
    for (const user of [alice, bob, mallory]) await saveUser(user, env);
    aliceSession = await CreateSession(alice.email, { email: alice.email, name: alice.name }, env);
    bobSession = await CreateSession(bob.email, { email: bob.email, name: bob.name }, env);
    mallorySession = await CreateSession(mallory.email, { email: mallory.email, name: mallory.name }, env);
    ({ app, base, http: httpBase } = await startServer(env));
  });

  afterEach(async () => {
    for (const p of providers.splice(0)) {
      p.destroy();
      p.doc.destroy();
    }
    await Promise.all(raws.splice(0).map((c) => c.close()));
    setYjsRoomGraceMs(30_000);
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('(a) converges two WebsocketProvider clients, including concurrent inserts', async () => {
    const id = await newSubmission();
    const a = provider(id, aliceSession);
    await synced(a);
    const aText = a.doc.get('root', Y.XmlText) as Y.XmlText;
    aText.insert(0, 'Hello');

    const b = provider(id, bobSession);
    await synced(b);
    const bText = b.doc.get('root', Y.XmlText) as Y.XmlText;
    expect(bText.toString()).toBe('Hello');

    // A types, B sees it.
    aText.insert(5, ' world');
    await eventually(() => bText.toString() === 'Hello world');

    // Concurrent inserts: both edit before either sees the other's change.
    aText.insert(0, '[A]');
    bText.insert(bText.length, '[B]');
    await eventually(() => aText.toString().includes('[B]') && bText.toString().includes('[A]'));
    expect(aText.toString()).toBe('[A]Hello world[B]');
    expect(bText.toString()).toBe(aText.toString());
    // Same position at the same time: both survive, in the same order on both sides.
    aText.insert(3, 'x');
    bText.insert(3, 'y');
    await eventually(() => aText.length === bText.length && aText.length === '[A]Hello world[B]'.length + 2);
    expect(aText.toString()).toBe(bText.toString());
    expect(aText.toString()).toMatch(/^\[A\](xy|yx)Hello world\[B\]$/);

    // Identical CRDT state on both clients and on the server.
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
    const serverDoc = getYjsRoomDoc(id)!;
    expect(serverDoc.get('root', Y.XmlText).toString()).toBe(aText.toString());
  });

  it('(a) relays awareness, echoes it to the sender, and removes it when a client leaves', async () => {
    const id = await newSubmission();
    const a = provider(id, aliceSession);
    await synced(a);
    a.doc.getText('t').insert(0, 'seed');
    const b = provider(id, bobSession);
    await synced(b);

    a.awareness.setLocalStateField('user', { name: 'Alice' });
    await eventually(() => b.awareness.getStates().get(a.doc.clientID)?.user?.name === 'Alice');

    // The server echoes awareness to the sender too (it keeps a lone client's
    // 30 s no-message watchdog satisfied).
    const echoed = new Promise<void>((resolve) => {
      ((a as any).ws as WebSocket).on('message', (data: ArrayBuffer) => {
        const d = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(d) === messageAwareness) resolve();
      });
    });
    a.awareness.setLocalStateField('cursor', 3);
    await echoed;

    a.destroy();
    await eventually(() => !b.awareness.getStates().has(a.doc.clientID));
  });

  it('(b) two clients joining an empty room at once: exactly one seeds, the other syncs after the seed and sees it once', async () => {
    const id = await newSubmission();
    const SAVED = 'Saved content';
    // Lexical's CollaborationPlugin rule: on first sync, bootstrap from saved content if the doc is empty.
    const bootstrapOnFirstSync = (c: RawYClient) => {
      let done = false;
      return () => {
        if (done || c.count('step2') === 0) return;
        done = true;
        if (c.text.length === 0) c.text.insert(0, SAVED);
      };
    };

    const x = raw(id, aliceSession);
    const y = raw(id, bobSession);
    await Promise.all([x.opened(), y.opened()]);
    await eventually(() => x.count('step2') + y.count('step2') >= 1);
    await sleep(150);

    // Exactly one got its step-1 reply; the other has received no doc state at all.
    const [seeder, held] = x.count('step2') === 1 ? [x, y] : [y, x];
    expect(seeder.count('step2')).toBe(1);
    expect(held.docFrames()).toEqual([]);
    expect(held.count('step1')).toBe(0);
    // The seeder's step 2 is the (empty) server state, followed by the server's step 1.
    expect(seeder.text.length).toBe(0);
    expect(seeder.doc.store.clients.size).toBe(0);
    await seeder.waitUntil(() => seeder.count('step1') === 1);

    const seederBootstrap = bootstrapOnFirstSync(seeder);
    const heldBootstrap = bootstrapOnFirstSync(held);
    seederBootstrap();
    expect(seeder.text.toString()).toBe(SAVED);

    await held.waitUntil(() => held.count('step2') === 1);
    heldBootstrap(); // doc is non-empty when it first syncs, so it must not bootstrap
    expect(held.text.toString()).toBe(SAVED);
    // It got the state exactly once: in step 2, never as a separate update.
    expect(held.count('update')).toBe(0);
    expect(held.docFrames()).toHaveLength(1);

    await sleep(100);
    expect(seeder.text.toString()).toBe(SAVED);
    expect(held.text.toString()).toBe(SAVED);
    expect(getYjsRoomDoc(id)!.getText('t').toString()).toBe(SAVED);
  });

  it('(b) stock WebsocketProvider clients joining at once bootstrap exactly once', async () => {
    const id = await newSubmission();
    const SAVED = 'Saved content';
    const ps = [provider(id, aliceSession), provider(id, bobSession), provider(id, aliceSession)];
    // Each client bootstraps on sync if its doc is empty (what CollaborationPlugin does).
    ps.forEach((p) => p.once('sync', (state: boolean) => {
      const t = p.doc.getText('t');
      if (state && t.length === 0) t.insert(0, SAVED);
    }));
    await Promise.all(ps.map((p) => synced(p)));
    await eventually(() => ps.every((p) => p.doc.getText('t').toString() === SAVED));
    await sleep(150);
    for (const p of ps) expect(p.doc.getText('t').toString()).toBe(SAVED);
    expect(getYjsRoomDoc(id)!.getText('t').toString()).toBe(SAVED);
  });

  it('(c) hands the seeder role to the waiting client when the seeder leaves without seeding', async () => {
    const id = await newSubmission();
    const first = raw(id, aliceSession);
    await first.waitUntil(() => first.count('step2') === 1);
    const waiting = raw(id, bobSession);
    await waiting.opened();
    const late = raw(id, aliceSession, { sendStep1OnOpen: false });
    await late.opened();
    await sleep(150);
    expect(waiting.docFrames()).toEqual([]);

    await first.close();
    await waiting.waitUntil(() => waiting.count('step2') === 1);
    expect(waiting.text.length).toBe(0); // the empty server state: it's the seeder now
    await waiting.waitUntil(() => waiting.count('step1') === 1);

    // The third client is still held.
    late.sendStep1();
    await sleep(150);
    expect(late.docFrames()).toEqual([]);

    waiting.text.insert(0, 'seeded by the second client');
    await late.waitUntil(() => late.count('step2') === 1);
    expect(late.text.toString()).toBe('seeded by the second client');
  });

  it('(c) promotes a held client whose step 1 has not arrived yet when it sends it', async () => {
    const id = await newSubmission();
    const first = raw(id, aliceSession);
    await first.waitUntil(() => first.count('step2') === 1);
    const quiet = raw(id, bobSession, { sendStep1OnOpen: false });
    await quiet.opened();
    await sleep(50);
    await first.close();
    await eventually(() => getYjsRoomDoc(id) !== undefined);
    await sleep(100);
    expect(quiet.frames.filter((f) => f.kind !== 'awareness')).toEqual([]);

    quiet.sendStep1();
    await quiet.waitUntil(() => quiet.count('step2') === 1);
    quiet.text.insert(0, 'ok');
    await eventually(() => getYjsRoomDoc(id)!.getText('t').toString() === 'ok');
  });

  it('(d) a late joiner receives the full state', async () => {
    const id = await newSubmission();
    const a = provider(id, aliceSession);
    await synced(a);
    const t = a.doc.getText('t');
    t.insert(0, 'one');
    const b = provider(id, bobSession);
    await synced(b);
    b.doc.getText('t').insert(3, ' two');
    await eventually(() => t.toString() === 'one two');
    t.insert(t.length, ' three');
    t.delete(0, 4);
    a.doc.getMap('meta').set('k', 'v');
    await eventually(() => b.doc.getText('t').toString() === 'two three');

    const late = raw(id, aliceSession);
    await late.waitUntil(() => late.count('step2') === 1);
    expect(late.text.toString()).toBe('two three');
    expect(late.doc.getMap('meta').get('k')).toBe('v');
    expect(Y.encodeStateVector(late.doc)).toEqual(Y.encodeStateVector(a.doc));

    const lateProvider = provider(id, bobSession);
    await synced(lateProvider);
    expect(lateProvider.doc.getText('t').toString()).toBe('two three');
  });

  it('(e) keeps the doc through the grace period and destroys the room after it', async () => {
    setYjsRoomGraceMs(300);
    const id = await newSubmission();
    const a = raw(id, aliceSession);
    await a.waitUntil(() => a.count('step2') === 1);
    a.text.insert(0, 'kept');
    await eventually(() => getYjsRoomDoc(id)?.getText('t').toString() === 'kept');
    await a.close();
    await sleep(50);
    expect(hasYjsRoom(id)).toBe(true);

    // Reconnect within the window: the doc is still there.
    const b = raw(id, bobSession);
    await b.waitUntil(() => b.count('step2') === 1);
    expect(b.text.toString()).toBe('kept');
    await b.close();

    // Nobody comes back: the room is destroyed after the grace period.
    await sleep(150);
    expect(hasYjsRoom(id)).toBe(true);
    await eventually(() => !hasYjsRoom(id), 2000);

    // The next session starts from an empty doc and seeds again.
    const c = raw(id, aliceSession);
    await c.waitUntil(() => c.count('step2') === 1);
    expect(c.doc.store.clients.size).toBe(0);
  });

  it('(f) rejects upgrades without a session or access, like the room sockets', async () => {
    const id = await newSubmission();
    const missing = await expectRejected(`${base}/api/ws/yjs/submissions/${id}`);
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toEqual({ error: 'Session ID is required' });

    const invalid = await expectRejected(`${base}/api/ws/yjs/submissions/${id}?sessionId=not-a-session`);
    expect(invalid.status).toBe(403);
    expect(JSON.parse(invalid.body)).toEqual({ error: 'Session not found or expired' });

    const denied = await expectRejected(`${base}/api/ws/yjs/submissions/${id}?sessionId=${mallorySession}`);
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toEqual({ error: 'Access denied' });

    const noSubmission = await expectRejected(`${base}/api/ws/yjs/submissions/nope?sessionId=${aliceSession}`);
    expect(noSubmission.status).toBe(404);

    // Only submissions have a Yjs socket.
    const doc = await expectRejected(`${base}/api/ws/yjs/documents/doc-1?sessionId=${aliceSession}`);
    expect(doc.status).toBe(404);
    expect(hasYjsRoom(id)).toBe(false);
  });

  it('(g) keeps the Yjs path and the JSON room path separate', async () => {
    const id = await newSubmission();
    const room = new WebSocket(`${base}/api/ws/submissions/${id}?sessionId=${aliceSession}`);
    const roomMessages: any[] = [];
    room.on('message', (data, isBinary) => roomMessages.push(isBinary ? 'binary' : JSON.parse(data.toString())));
    await new Promise((resolve) => room.once('open', resolve));
    await eventually(() => roomMessages.some((m) => m.type === 'connected'));

    const y = raw(id, bobSession);
    await y.waitUntil(() => y.count('step2') === 1);
    y.text.insert(0, 'hello');
    await eventually(() => getYjsRoomDoc(id)?.getText('t').toString() === 'hello');
    await sleep(100);

    // The JSON room saw no Yjs traffic and no join from the Yjs client; the Yjs
    // client received only binary protocol frames.
    expect(roomMessages.every((m) => m !== 'binary')).toBe(true);
    expect(roomMessages.filter((m) => m.type === 'user_joined')).toEqual([]);
    expect(y.frames.every((f) => ['step1', 'step2', 'update', 'awareness'].includes(f.kind))).toBe(true);
    await new Promise<void>((resolve) => { room.once('close', () => resolve()); room.close(); });

    const plain = await fetch(`${httpBase}/api/ws/yjs/submissions/${id}`);
    expect(plain.status).toBe(426);
  });

  it('answers messageQueryAwareness with every awareness state', async () => {
    const id = await newSubmission();
    const a = provider(id, aliceSession);
    await synced(a);
    a.awareness.setLocalStateField('user', { name: 'Alice' });
    const q = raw(id, bobSession);
    await q.opened();
    await eventually(() => q.count('awareness') >= 1); // the join snapshot
    const before = q.count('awareness');
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageQueryAwareness);
    q.sendRaw(encoding.toUint8Array(encoder));
    await q.waitUntil(() => q.count('awareness') > before);
    const remote = new awarenessProtocol.Awareness(new Y.Doc());
    awarenessProtocol.applyAwarenessUpdate(remote, q.frames.filter((f) => f.kind === 'awareness').pop()!.data, null);
    expect(remote.getStates().get(a.doc.clientID)).toMatchObject({ user: { name: 'Alice' } });
    remote.destroy();
  });

  it('ignores doc messages from a held client and collects its state after release', async () => {
    const id = await newSubmission();
    const seeder = raw(id, aliceSession);
    await seeder.waitUntil(() => seeder.count('step2') === 1);
    const held = raw(id, bobSession);
    await held.opened();
    await sleep(50);
    // A held client edits (e.g. a reconnect with local state). It must not seed.
    held.doc.getMap('m').set('fromHeld', 1);
    await sleep(100);
    expect(getYjsRoomDoc(id)!.store.clients.size).toBe(0);
    expect(held.docFrames()).toEqual([]);

    seeder.text.insert(0, 'seed');
    await held.waitUntil(() => held.count('step2') === 1);
    expect(held.text.toString()).toBe('seed');
    // The server's step 1 after release collects what the held client had.
    await eventually(() => seeder.doc.getMap('m').get('fromHeld') === 1);
    expect(getYjsRoomDoc(id)!.getMap('m').get('fromHeld')).toBe(1);
  });

  it('closes the socket on text frames and on undecodable messages', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const id = await newSubmission();
    const t = raw(id, aliceSession);
    await t.opened();
    const textClosed = new Promise<number>((resolve) => t.ws.once('close', (code) => resolve(code)));
    t.sendRaw('{"type":"ping"}');
    expect(await textClosed).toBe(1003);

    const g = raw(id, aliceSession);
    await g.opened();
    const garbageClosed = new Promise<number>((resolve) => g.ws.once('close', (code) => resolve(code)));
    g.sendRaw(new Uint8Array([messageSync, 9]));
    expect(await garbageClosed).toBe(1007);
    errors.mockRestore();
  });
});

describe('Yjs collaboration socket (DEV_BYPASS_AUTH, ping, payload limit)', () => {
  const LIMIT = 4096;
  let app: AppServer;
  let base: string;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {}); // the 1009 close logs a socket error
    setYjsPingIntervalMs(100);
    const env = loadConfig({ ...BASE_ENV, DEV_BYPASS_AUTH: 'true' }, { store: new MemoryObjectStore() }).env;
    ({ app, base } = await startServer(env, { wsMaxPayloadBytes: LIMIT }));
  });

  afterEach(() => {
    sockets.splice(0).forEach((ws) => ws.terminate());
  });

  afterAll(async () => {
    setYjsPingIntervalMs(30_000);
    await app.close();
    jest.restoreAllMocks();
  });

  it('accepts the dev user but still requires a sessionId', async () => {
    const missing = await expectRejected(`${base}/api/ws/yjs/submissions/any`);
    expect(missing.status).toBe(400);
    const ws = new WebSocket(`${base}/api/ws/yjs/submissions/any?sessionId=dev`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  });

  it('sends protocol-level pings (never JSON frames)', async () => {
    const ws = new WebSocket(`${base}/api/ws/yjs/submissions/ping-room?sessionId=dev`);
    sockets.push(ws);
    const textFrames: string[] = [];
    ws.on('message', (data, isBinary) => { if (!isBinary) textFrames.push(data.toString()); });
    await new Promise<void>((resolve) => ws.once('ping', () => resolve()));
    expect(textFrames).toEqual([]);
  });

  it('closes the socket with 1009 for a message over WS_MAX_PAYLOAD_BYTES', async () => {
    const ws = new WebSocket(`${base}/api/ws/yjs/submissions/big?sessionId=dev`);
    sockets.push(ws);
    await new Promise((resolve) => ws.once('open', resolve));
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    encoding.writeVarUint(encoder, syncProtocol.messageYjsUpdate);
    encoding.writeVarUint8Array(encoder, new Uint8Array(LIMIT * 2));
    ws.send(encoding.toUint8Array(encoder));
    expect(await closed).toBe(1009);
  });
});
