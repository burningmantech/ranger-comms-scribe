/**
 * Room sockets after they joined: closed when their session ends (sign-out, a password reset)
 * or their person loses access (taken off a request's approvers), and a sent request's Yjs room
 * takes no edits. Starts the real Node server and connects real `ws` clients and y-websocket
 * providers, like the other realtime tests.
 */
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { createAppServer, AppServer } from '../../src/httpServer';
import { configureCors } from '../../src/index';
import { loadConfig } from '../../src/config/env';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { Env, CreateSession, DeleteSession, DeleteSessionsForUser } from '../../src/utils/sessionManager';
import { saveUser } from '../../src/services/userService';
import { putObject, clearMemoryCache } from '../../src/services/cacheService';
import { CLOSE_ACCESS_REMOVED, CLOSE_SESSION_ENDED, recheckRoomAccess } from '../../src/handlers/websocket';
import { getYjsRoomDoc, setYjsRoomReadOnly } from '../../src/realtime/yjsRooms';
import { User, UserType } from '../../src/types';

const BASE_ENV = {
  STORE_DRIVER: 'memory',
  PUBLIC_URL: 'http://localhost/api',
  FRONTEND_URL: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: 'test-client',
  TURNSTILESECRET: 'test-secret',
};

const cadre: User = {
  id: 'cadre-id', email: 'cadre@example.com', name: 'Cadre', userType: UserType.CommsCadre,
  isAdmin: false, commsCadre: true, councilRole: null, accessVersion: 1, verified: true, groups: [], roles: ['CommsCadre'],
} as User;
const approver: User = {
  id: 'approver-id', email: 'approver@example.com', name: 'Approver', userType: UserType.Member,
  isAdmin: false, commsCadre: false, councilRole: null, accessVersion: 1, verified: true, groups: [], roles: ['Member'],
} as User;

let env: Env;
let app: AppServer;
let base: string;
let nextId = 0;
const sockets: WebSocket[] = [];
const providers: WebsocketProvider[] = [];

async function newSubmission(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = `access-sub-${++nextId}`;
  await putObject(`content_submissions/${id}`, {
    id, title: 'T', content: 'C', submittedBy: 'someone-else', status: 'in_review',
    requiredApprovers: [approver.email], ...overrides,
  }, env);
  return id;
}

/** Open a JSON room socket, or a Yjs socket (`yjs`), and resolve once it is open. */
function open(submissionId: string, sessionId: string, yjs = false): Promise<WebSocket> {
  const path = yjs ? `/api/ws/yjs/submissions/${submissionId}` : `/api/ws/submissions/${submissionId}`;
  const ws = new WebSocket(`${base}${path}?sessionId=${encodeURIComponent(sessionId)}`);
  ws.once('close', (code) => closeCodes.set(ws, code));
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const closeCodes = new Map<WebSocket, number>();

/** The code the socket was (or is about to be) closed with. */
function closed(ws: WebSocket, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (closeCodes.has(ws)) return resolve(closeCodes.get(ws)!);
    const timer = setTimeout(() => reject(new Error('socket stayed open')), timeoutMs);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function provider(submissionId: string, sessionId: string, doc = new Y.Doc()): WebsocketProvider {
  const p = new WebsocketProvider(`${base}/api/ws/yjs/submissions`, submissionId, doc, {
    params: { sessionId }, WebSocketPolyfill: WebSocket as any, disableBc: true,
  });
  providers.push(p);
  return p;
}

const synced = (p: WebsocketProvider): Promise<void> => new Promise((resolve, reject) => {
  if (p.synced) return resolve();
  const timer = setTimeout(() => reject(new Error('Provider did not sync')), 3000);
  p.once('sync', (state: boolean) => {
    clearTimeout(timer);
    if (state) resolve();
  });
});

beforeAll(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  clearMemoryCache();
  env = loadConfig(BASE_ENV, { store: new MemoryObjectStore() }).env;
  configureCors(env.CORS_ORIGINS);
  for (const user of [cadre, approver]) await saveUser(user, env);
  app = createAppServer(env);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
  base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const p of providers.splice(0)) {
    p.destroy();
    p.doc.destroy();
  }
  for (const ws of sockets.splice(0)) ws.terminate();
});

afterAll(async () => {
  await app.close();
  jest.restoreAllMocks();
});

describe('when sessions end', () => {
  it('closes the JSON and Yjs sockets of every session a password reset ends', async () => {
    const id = await newSubmission();
    const s1 = await CreateSession(cadre.email, { email: cadre.email, name: cadre.name }, env);
    const s2 = await CreateSession(cadre.email, { email: cadre.email, name: cadre.name }, env);
    const json = await open(id, s1);
    const yjs = await open(id, s2, true);

    expect(await DeleteSessionsForUser(cadre.email, env)).toBe(2);

    expect(await closed(json)).toBe(CLOSE_SESSION_ENDED);
    expect(await closed(yjs)).toBe(CLOSE_SESSION_ENDED);
  });

  it('closes only the signed-out session\'s socket', async () => {
    const id = await newSubmission();
    const out = await CreateSession(cadre.email, { email: cadre.email, name: cadre.name }, env);
    const stays = await CreateSession(cadre.email, { email: cadre.email, name: cadre.name }, env);
    const a = await open(id, out);
    const b = await open(id, stays);

    await DeleteSession(out, env);

    expect(await closed(a)).toBe(CLOSE_SESSION_ENDED);
    await sleep(200);
    expect(b.readyState).toBe(WebSocket.OPEN);
  });
});

describe('when access changes', () => {
  it('closes the sockets of an approver taken off the list, and keeps a reviewer\'s', async () => {
    const id = await newSubmission();
    const approverSession = await CreateSession(approver.email, { email: approver.email, name: approver.name }, env);
    const cadreSession = await CreateSession(cadre.email, { email: cadre.email, name: cadre.name }, env);
    const approverJson = await open(id, approverSession);
    const approverYjs = await open(id, approverSession, true);
    const cadreJson = await open(id, cadreSession);

    expect(await recheckRoomAccess(env, { submissionId: id })).toBe(0); // still on the list
    await putObject(`content_submissions/${id}`, {
      id, title: 'T', content: 'C', submittedBy: 'someone-else', status: 'in_review', requiredApprovers: [],
    }, env);
    expect(await recheckRoomAccess(env, { submissionId: id })).toBe(2);

    expect(await closed(approverJson)).toBe(CLOSE_ACCESS_REMOVED);
    expect(await closed(approverYjs)).toBe(CLOSE_ACCESS_REMOVED);
    expect(cadreJson.readyState).toBe(WebSocket.OPEN);
  });
});

describe('a sent request\'s Yjs room', () => {
  it('is seeded with the saved text but takes no edits after', async () => {
    const id = await newSubmission({ status: 'sent' });
    const session = await CreateSession(cadre.email, { email: cadre.email, name: cadre.name }, env);
    const seedDoc = new Y.Doc();
    seedDoc.getText('t').insert(0, 'As sent');
    const p = provider(id, session, seedDoc);
    await synced(p);
    await sleep(200);
    expect(getYjsRoomDoc(id)?.getText('t').toString()).toBe('As sent');

    seedDoc.getText('t').insert(0, 'Edited: ');
    await sleep(300);
    expect(getYjsRoomDoc(id)?.getText('t').toString()).toBe('As sent');
  });

  it('stops taking edits when the request is sent while the room is open', async () => {
    const id = await newSubmission();
    const session = await CreateSession(cadre.email, { email: cadre.email, name: cadre.name }, env);
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'Draft');
    const p = provider(id, session, doc);
    await synced(p);
    doc.getText('t').insert(5, ' one');
    await sleep(300);
    expect(getYjsRoomDoc(id)?.getText('t').toString()).toBe('Draft one');

    setYjsRoomReadOnly(id);
    doc.getText('t').insert(9, ' two');
    await sleep(300);
    expect(getYjsRoomDoc(id)?.getText('t').toString()).toBe('Draft one');
  });
});
