/**
 * Protocol test for the WebSocket rooms that replaced the Durable Object.
 * Starts the real Node server (REST + upgrades) on an ephemeral port and talks to it
 * with real `ws` clients, checking the message shapes the frontend client
 * (frontend/src/services/websocketService.ts) relies on.
 */
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { createAppServer, AppServer, AppServerOptions } from '../../src/httpServer';
import { configureCors } from '../../src/index';
import { loadConfig } from '../../src/config/env';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { Env, CreateSession } from '../../src/utils/sessionManager';
import { saveUser } from '../../src/services/userService';
import { putObject, clearMemoryCache } from '../../src/services/cacheService';
import { broadcastToSubmissionRoom, broadcastToDocumentRoom } from '../../src/handlers/websocket';
import { setPingIntervalMs } from '../../src/realtime/rooms';
import { User, UserType } from '../../src/types';

type Msg = Record<string, any>;

class TestClient {
  readonly messages: Msg[] = [];
  readonly ws: WebSocket;
  private waiters: Array<() => void> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    // Attach the collector immediately: the server sends room_state/connected right after the handshake.
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()));
      this.waiters.forEach((wake) => wake());
    });
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(message: Msg): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Resolve with the first message (from index `from`) matching `predicate`. */
  waitFor(predicate: (m: Msg) => boolean, timeoutMs = 3000, from = 0): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.messages.slice(from).find(predicate);
        if (found) {
          clearTimeout(timer);
          this.waiters = this.waiters.filter((w) => w !== check);
          resolve(found);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== check);
        reject(new Error(`Timed out waiting for message; got ${JSON.stringify(this.messages.map((m) => m.type))}`));
      }, timeoutMs);
      if (!check()) this.waiters.push(check);
    });
  }

  /** Assert nothing matching `predicate` arrives within `ms`. */
  async expectNone(predicate: (m: Msg) => boolean, ms = 300): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    expect(this.messages.filter(predicate)).toEqual([]);
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

describe('real-time rooms (real sessions)', () => {
  let env: Env;
  let app: AppServer;
  let base: string;
  let httpBase: string;
  let aliceSession: string;
  let bobSession: string;
  let mallorySession: string;
  const submissionId = 'sub-123';
  const clients: TestClient[] = [];

  const connect = (path: string, sessionId: string) => {
    const client = new TestClient(`${base}${path}?sessionId=${encodeURIComponent(sessionId)}&userId=spoofed&userName=Spoofed`);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    clearMemoryCache();
    env = loadConfig(BASE_ENV, { store: new MemoryObjectStore() }).env;
    configureCors(env.CORS_ORIGINS);
    for (const user of [alice, bob, mallory]) await saveUser(user, env);
    aliceSession = await CreateSession(alice.email, { email: alice.email, name: alice.name }, env);
    bobSession = await CreateSession(bob.email, { email: bob.email, name: bob.name }, env);
    mallorySession = await CreateSession(mallory.email, { email: mallory.email, name: mallory.name }, env);
    await putObject(`content_submissions/${submissionId}`, {
      id: submissionId, title: 'T', content: 'C', submittedBy: 'someone-else', requiredApprovers: [],
    }, env);
    await putObject('documents/doc-9', {
      id: 'doc-9', title: 'D', content: '', isPublic: false,
      permissions: { owner: 'someone-else', editors: [bob.id], viewers: [], commenters: [], allowComments: true },
    }, env);
    ({ app, base, http: httpBase } = await startServer(env));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('runs the join protocol: room_state and connected for the joiner, user_joined for the others', async () => {
    const a = connect(`/api/ws/submissions/${submissionId}`, aliceSession);
    await a.opened();
    const aConnected = await a.waitFor((m) => m.type === 'connected');
    expect(aConnected).toMatchObject({
      type: 'connected', submissionId, userId: alice.id, userName: 'Alice', userEmail: alice.email,
    });
    expect(typeof aConnected.timestamp).toBe('string');
    const aState = await a.waitFor((m) => m.type === 'room_state');
    expect(aState).toMatchObject({ userId: 'system', userName: 'System', userEmail: 'system@websocket', submissionId });
    expect(aState.users.map((u: Msg) => u.userEmail)).toEqual([alice.email]);
    expect(typeof aState.seq).toBe('number');

    const b = connect(`/api/ws/submissions/${submissionId}`, bobSession);
    await b.opened();
    await b.waitFor((m) => m.type === 'connected');
    const bState = await b.waitFor((m) => m.type === 'room_state');
    expect(bState.users.map((u: Msg) => u.userEmail).sort()).toEqual([alice.email, bob.email]);
    expect(bState.users[0]).toEqual(expect.objectContaining({
      userId: expect.any(String), userName: expect.any(String), userEmail: expect.any(String), connectedAt: expect.any(String),
    }));

    const joined = await a.waitFor((m) => m.type === 'user_joined');
    expect(joined).toMatchObject({ userId: bob.id, userName: 'Bob', userEmail: bob.email, submissionId });
    // Alice also receives the refreshed room_state with both users.
    await a.waitFor((m) => m.type === 'room_state' && m.users.length === 2);
    // The joiner does not get its own user_joined.
    await b.expectNone((m) => m.type === 'user_joined' && m.userEmail === bob.email, 100);
  });

  it('relays messages to the rest of the room with server-stamped identity and increasing seq', async () => {
    const a = connect(`/api/ws/submissions/${submissionId}`, aliceSession);
    const b = connect(`/api/ws/submissions/${submissionId}`, bobSession);
    await Promise.all([a.opened(), b.opened()]);
    await a.waitFor((m) => m.type === 'room_state' && m.users.length === 2);
    await b.waitFor((m) => m.type === 'room_state' && m.users.length === 2);

    const startA = a.messages.length;
    a.send({ type: 'cursor_position', userId: 'forged', userName: 'Forged', userEmail: 'forged@x', data: { position: 1 } });
    a.send({ type: 'realtime_content_update', data: { content: '{"root":{}}' } });

    const first = await b.waitFor((m) => m.type === 'cursor_position');
    const second = await b.waitFor((m) => m.type === 'realtime_content_update');
    expect(first).toMatchObject({
      userId: alice.id, userName: 'Alice', userEmail: alice.email, submissionId, data: { position: 1 },
    });
    expect(typeof first.timestamp).toBe('string');
    expect(second.data).toEqual({ content: '{"root":{}}' });
    expect(second.seq).toBe(first.seq + 1);

    // Seq is per room and monotonic across everything B received.
    const seqs = b.messages.filter((m) => typeof m.seq === 'number').map((m) => m.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);

    // The sender does not get its own relayed messages.
    await a.expectNone((m) => m.type === 'cursor_position' || m.type === 'realtime_content_update', 200);
    expect(a.messages.length).toBe(startA);
  });

  it('answers ping with pong and heartbeat with heartbeat_response (to the sender only)', async () => {
    const a = connect(`/api/ws/submissions/${submissionId}`, aliceSession);
    const b = connect(`/api/ws/submissions/${submissionId}`, bobSession);
    await Promise.all([a.opened(), b.opened()]);
    await a.waitFor((m) => m.type === 'connected');
    await b.waitFor((m) => m.type === 'connected');

    a.send({ type: 'ping', timestamp: new Date().toISOString() });
    const pong = await a.waitFor((m) => m.type === 'pong');
    expect(pong).toMatchObject({ userId: alice.id, userEmail: alice.email, submissionId });

    a.send({ type: 'heartbeat' });
    const hb = await a.waitFor((m) => m.type === 'heartbeat_response');
    expect(hb).toMatchObject({ userId: alice.id, submissionId });

    // Client pongs (answers to server pings) are swallowed, not relayed.
    a.send({ type: 'pong' });
    await b.expectNone((m) => ['ping', 'pong', 'heartbeat', 'heartbeat_response'].includes(m.type), 200);
  });

  it('replies with an error message to invalid JSON', async () => {
    const a = connect(`/api/ws/submissions/${submissionId}`, aliceSession);
    await a.opened();
    a.ws.send('not json');
    const err = await a.waitFor((m) => m.type === 'error');
    expect(err.message).toBe('Failed to process message');
  });

  it('delivers broadcastToSubmissionRoom to every client in the room', async () => {
    const a = connect(`/api/ws/submissions/${submissionId}`, aliceSession);
    const b = connect(`/api/ws/submissions/${submissionId}`, bobSession);
    await Promise.all([a.opened(), b.opened()]);
    await a.waitFor((m) => m.type === 'room_state' && m.users.length === 2);

    await broadcastToSubmissionRoom(submissionId, {
      type: 'approval_added', userId: 'x-id', userName: 'X', userEmail: 'x@example.com', data: { decision: 'approved' },
    }, env);

    for (const client of [a, b]) {
      const msg = await client.waitFor((m) => m.type === 'approval_added');
      expect(msg).toMatchObject({ submissionId, userName: 'X', data: { decision: 'approved' } });
      expect(typeof msg.seq).toBe('number');
      expect(typeof msg.timestamp).toBe('string');
    }
  });

  it('broadcasts user_left and an updated room_state when a client disconnects', async () => {
    const a = connect(`/api/ws/submissions/${submissionId}`, aliceSession);
    const b = connect(`/api/ws/submissions/${submissionId}`, bobSession);
    await Promise.all([a.opened(), b.opened()]);
    await a.waitFor((m) => m.type === 'room_state' && m.users.length === 2);

    const from = a.messages.length;
    await b.close();
    const left = await a.waitFor((m) => m.type === 'user_left', 3000, from);
    expect(left).toMatchObject({ userId: bob.id, userName: 'Bob', userEmail: bob.email, submissionId });
    const state = await a.waitFor((m) => m.type === 'room_state', 3000, from);
    expect(state.users.map((u: Msg) => u.userEmail)).toEqual([alice.email]);
  });

  it('has no HTTP routes to broadcast into a room or list its members', async () => {
    const a = connect(`/api/ws/submissions/${submissionId}`, aliceSession);
    await a.opened();
    await a.waitFor((m) => m.type === 'connected');

    // Any logged-in user (Mallory has no access to the submission) used to be able to
    // inject messages and list members through these.
    for (const kind of ['submissions', 'documents']) {
      const id = kind === 'submissions' ? submissionId : 'doc-9';
      const postRes = await fetch(`${httpBase}/api/ws/${kind}/${id}/broadcast`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${mallorySession}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'comment_added', data: { text: 'injected' } }),
      });
      expect(postRes.status).toBe(404);

      const roomRes = await fetch(`${httpBase}/api/ws/${kind}/${id}/room`, {
        headers: { Authorization: `Bearer ${mallorySession}` },
      });
      expect(roomRes.status).toBe(404);
    }
    await a.expectNone((m) => m.type === 'comment_added', 200);
  });

  it('answers 426 to a plain GET on the upgrade paths', async () => {
    const plain = await fetch(`${httpBase}/api/ws/submissions/${submissionId}`);
    expect(plain.status).toBe(426);
    const plainDoc = await fetch(`${httpBase}/api/ws/documents/doc-9`);
    expect(plainDoc.status).toBe(426);
  });

  it('uses the same document:<id> key for connections and broadcasts', async () => {
    const documentId = 'doc-9';
    const a = connect(`/api/ws/documents/${documentId}`, aliceSession);
    const b = connect(`/api/ws/documents/${documentId}`, bobSession);
    await Promise.all([a.opened(), b.opened()]);
    const connected = await a.waitFor((m) => m.type === 'connected');
    expect(connected).toMatchObject({ documentId, userEmail: alice.email });
    expect(connected.submissionId).toBeUndefined();
    await a.waitFor((m) => m.type === 'user_joined' && m.userEmail === bob.email);

    b.send({ type: 'text_operation', data: { op: 'insert' } });
    const relayed = await a.waitFor((m) => m.type === 'text_operation');
    expect(relayed).toMatchObject({ documentId, userId: bob.id, data: { op: 'insert' } });

    await broadcastToDocumentRoom(documentId, {
      type: 'content_updated', userId: 'srv', userName: 'Server', userEmail: 'srv@x', data: { v: 2 },
    }, env);
    for (const client of [a, b]) {
      const msg = await client.waitFor((m) => m.type === 'content_updated');
      expect(msg).toMatchObject({ documentId, data: { v: 2 } });
    }

    // Rooms are isolated: the submission room sees none of this.
    const s = connect(`/api/ws/submissions/${submissionId}`, aliceSession);
    await s.opened();
    await s.waitFor((m) => m.type === 'connected');
    await broadcastToDocumentRoom(documentId, {
      type: 'content_updated', userId: 'srv', userName: 'Server', userEmail: 'srv@x', data: { v: 3 },
    }, env);
    await s.expectNone((m) => m.type === 'content_updated', 200);
  });

  it('rejects upgrades without a valid session or access', async () => {
    const missing = await expectRejected(`${base}/api/ws/submissions/${submissionId}`);
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.body)).toEqual({ error: 'Session ID is required' });

    const invalid = await expectRejected(`${base}/api/ws/submissions/${submissionId}?sessionId=not-a-session`);
    expect(invalid.status).toBe(403);
    expect(JSON.parse(invalid.body)).toEqual({ error: 'Session not found or expired' });

    const noSubmission = await expectRejected(`${base}/api/ws/submissions/nope?sessionId=${aliceSession}`);
    expect(noSubmission.status).toBe(404);

    const denied = await expectRejected(`${base}/api/ws/submissions/${submissionId}?sessionId=${mallorySession}`);
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toEqual({ error: 'Access denied' });

    const docInvalid = await expectRejected(`${base}/api/ws/documents/doc-1?sessionId=bad`);
    expect(docInvalid.status).toBe(403);

    const noDocument = await expectRejected(`${base}/api/ws/documents/doc-1?sessionId=${aliceSession}`);
    expect(noDocument.status).toBe(404);
    expect(JSON.parse(noDocument.body)).toEqual({ error: 'Document not found' });

    const docDenied = await expectRejected(`${base}/api/ws/documents/doc-9?sessionId=${mallorySession}`);
    expect(docDenied.status).toBe(403);
    expect(JSON.parse(docDenied.body)).toEqual({ error: 'Access denied' });

    const unknownPath = await expectRejected(`${base}/api/ws/other/thing?sessionId=${aliceSession}`);
    expect(unknownPath.status).toBe(404);
  });
});

describe('real-time rooms (DEV_BYPASS_AUTH and server ping)', () => {
  let app: AppServer;
  let base: string;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    setPingIntervalMs(150);
    const env = loadConfig({ ...BASE_ENV, DEV_BYPASS_AUTH: 'true' }, { store: new MemoryObjectStore() }).env;
    ({ app, base } = await startServer(env));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  afterAll(async () => {
    setPingIntervalMs(30000);
    await app.close();
    jest.restoreAllMocks();
  });

  it('uses the dev users without session or access checks', async () => {
    const a = new TestClient(`${base}/api/ws/submissions/any?sessionId=whatever`);
    const b = new TestClient(`${base}/api/ws/submissions/any?sessionId=x&testUser=user2`);
    clients.push(a, b);
    await Promise.all([a.opened(), b.opened()]);
    expect(await a.waitFor((m) => m.type === 'connected')).toMatchObject({ userId: 'dev-admin', userEmail: 'dev@localhost', userName: 'Dev Admin' });
    expect(await b.waitFor((m) => m.type === 'connected')).toMatchObject({ userId: 'dev-user2', userEmail: 'user2@localhost', userName: 'Test Reviewer' });
  });

  it('still requires a sessionId', async () => {
    const res = await expectRejected(`${base}/api/ws/submissions/any`);
    expect(res.status).toBe(400);
  });

  it('sends periodic server pings', async () => {
    const a = new TestClient(`${base}/api/ws/submissions/pinged?sessionId=s`);
    clients.push(a);
    await a.opened();
    const ping = await a.waitFor((m) => m.type === 'ping', 2000);
    expect(ping).toMatchObject({ userId: 'server', userName: 'Server', userEmail: 'server@websocket', submissionId: 'pinged' });
  });
});

describe('real-time rooms (WS_MAX_PAYLOAD_BYTES)', () => {
  const LIMIT = 1024;
  let app: AppServer;
  let base: string;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const env = loadConfig({ ...BASE_ENV, DEV_BYPASS_AUTH: 'true' }, { store: new MemoryObjectStore() }).env;
    ({ app, base } = await startServer(env, { wsMaxPayloadBytes: LIMIT }));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('defaults to 16 MiB and reads overrides', () => {
    expect(loadConfig(BASE_ENV).wsMaxPayloadBytes).toBe(16 * 1024 * 1024);
    expect(loadConfig({ ...BASE_ENV, WS_MAX_PAYLOAD_BYTES: '4096' }).wsMaxPayloadBytes).toBe(4096);
    expect(() => loadConfig({ ...BASE_ENV, WS_MAX_PAYLOAD_BYTES: '0' })).toThrow('Invalid WS_MAX_PAYLOAD_BYTES');
  });

  it('relays messages under the limit and closes the socket with 1009 for a larger one', async () => {
    const a = new TestClient(`${base}/api/ws/submissions/big?sessionId=a`);
    const b = new TestClient(`${base}/api/ws/submissions/big?sessionId=b&testUser=user2`);
    clients.push(a, b);
    await Promise.all([a.opened(), b.opened()]);
    await a.waitFor((m) => m.type === 'room_state' && m.users.length === 2);

    a.send({ type: 'realtime_content_update', data: { content: 'x'.repeat(LIMIT / 2) } });
    await b.waitFor((m) => m.type === 'realtime_content_update');

    const closed = new Promise<number>((resolve) => a.ws.once('close', (code) => resolve(code)));
    a.send({ type: 'realtime_content_update', data: { content: 'x'.repeat(LIMIT * 2) } });
    expect(await closed).toBe(1009);

    // The rest of the room carries on: B sees A leave, and the server is still up.
    await b.waitFor((m) => m.type === 'user_left' && m.userEmail === 'dev@localhost');
  });
});
