import { canEditSubmission, isReviewer } from '../services/access';
import { AutoRouter, json } from 'itty-router';
import { Env, GetSession, onSessionsEnded } from '../utils/sessionManager';
import { getUser } from '../services/userService';
import { getObject } from '../services/cacheService';
import { getDevUser } from '../utils/devUsers';
import { canViewDocument, getDocument } from '../services/documentService';
import {
  RoomIdentity,
  RoomTarget,
  WebSocketMessage,
  broadcastToRoom,
  closeRoomConnection,
  documentRoomKey,
  roomConnections,
  submissionRoomKey,
} from '../realtime/rooms';
import { closeYjsConnection, yjsConnections } from '../realtime/yjsRooms';
import { User } from '../types';

/**
 * WebSocket upgrades for /api/ws/submissions/:id and /api/ws/documents/:id are
 * handled by the Node server's `upgrade` event (src/httpServer.ts), which calls
 * `authorizeRoomConnection` below and then joins the socket to a room in
 * src/realtime/rooms.ts. This router only sees plain HTTP requests.
 */
export const router = AutoRouter({ base: '/api/ws' });

export type RoomAuthResult =
  /** `sessionId` is set for a real session (not dev bypass); `readOnly` when the request has been sent. */
  | { ok: true; identity: RoomIdentity; sessionId?: string; readOnly?: boolean }
  | { ok: false; status: number; body: Record<string, unknown> };

type AccessResult = { ok: true; readOnly: boolean } | { ok: false; status: number; body: Record<string, unknown> };

/** Whether `user` may be in the room for `target` (the same rules as REST). */
async function roomAccess(target: RoomTarget, user: User, env: Env): Promise<AccessResult> {
  if (target.kind === 'submission') {
    const submission = await getObject<any>(`content_submissions/${target.id}`, env);
    if (!submission) {
      return { ok: false, status: 404, body: { error: 'Submission not found' } };
    }
    // Same rule as PUT /content/submissions/:id
    if (!(isReviewer(user, env) || canEditSubmission(user, submission))) {
      return { ok: false, status: 403, body: { error: 'Access denied' } };
    }
    return { ok: true, readOnly: submission.status === 'sent' };
  }
  // Same rule as GET /api/documents/:id
  const document = await getDocument(target.id, env);
  if (!document) {
    return { ok: false, status: 404, body: { error: 'Document not found' } };
  }
  if (!canViewDocument(document, user)) {
    return { ok: false, status: 403, body: { error: 'Access denied' } };
  }
  return { ok: true, readOnly: false };
}

/**
 * Session and access checks for joining a room. Same semantics as the old Worker
 * handler:
 *   - 400 when `sessionId` is missing (even with DEV_BYPASS_AUTH);
 *   - with DEV_BYPASS_AUTH=true, no further checks: a fake user from utils/devUsers.ts
 *     (dev-admin, or dev-user2 / dev-member when `testUser=user2|member` or the session
 *     ID contains "user2" / "member");
 *   - 403 for an unknown/expired session or a user that no longer exists;
 *   - 404 when the submission/document is missing, 403 without access. (The old
 *     handler skipped this for documents; harmless then because document broadcasts
 *     went to a mismatched room key, but with one key scheme they now deliver.)
 *
 * The room identity's `userId` is `user.id || user.email`, the same identity REST broadcasts
 * and the frontend (`currentUser.id || currentUser.email`) use, so a user isn't listed twice
 * in presence. (Before the migration it was the email, which made users see themselves as a
 * second collaborator.)
 */
export async function authorizeRoomConnection(
  target: RoomTarget,
  params: { sessionId: string | null; testUser?: string | null },
  env: Env
): Promise<RoomAuthResult> {
  const { sessionId, testUser } = params;
  if (!sessionId) {
    return { ok: false, status: 400, body: { error: 'Session ID is required' } };
  }

  if (env.DEV_BYPASS_AUTH === 'true') {
    // The same fake users as REST (utils/devUsers.ts)
    const devUser = getDevUser(sessionId, testUser);
    return { ok: true, identity: { userId: devUser.id, userName: devUser.name, userEmail: devUser.email } };
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return { ok: false, status: 403, body: { error: 'Session not found or expired' } };
  }

  const userData = session.data as { email: string; name: string };
  const user = await getUser(userData.email, env);
  if (!user) {
    return { ok: false, status: 403, body: { error: 'User not found' } };
  }

  const access = await roomAccess(target, user, env);
  if (!access.ok) return access;

  return {
    ok: true,
    identity: { userId: user.id || user.email, userName: user.name || userData.name, userEmail: user.email },
    sessionId,
    readOnly: access.readOnly,
  };
}

// Close codes for sockets the server ends (application range 4000-4999)
export const CLOSE_SESSION_ENDED = 4401;
export const CLOSE_ACCESS_REMOVED = 4403;

/** Close every room socket (JSON and Yjs) opened with one of these sessions. */
export function closeSessionSockets(sessionIds: string[]): number {
  const ended = new Set(sessionIds);
  let closed = 0;
  for (const c of roomConnections()) {
    if (c.sessionId && ended.has(c.sessionId)) {
      closeRoomConnection(c.ws, CLOSE_SESSION_ENDED, 'Session ended');
      closed += 1;
    }
  }
  for (const c of yjsConnections()) {
    if (c.sessionId && ended.has(c.sessionId)) {
      closeYjsConnection(c.ws, CLOSE_SESSION_ENDED, 'Session ended');
      closed += 1;
    }
  }
  return closed;
}

// Sign-out, expiry, a password reset or a deleted account ends sessions: their sockets go too
onSessionsEnded((sessionIds) => { closeSessionSockets(sessionIds); });

/**
 * Check open room sockets again after access changed: a request's approvers list
 * (`submissionId`), or one person's access on the People page (`email`). Sockets whose
 * session has ended or whose person may no longer be in the room are closed. Dev-bypass
 * sockets (no session) are left alone. Returns how many were closed.
 */
export async function recheckRoomAccess(env: Env, filter: { submissionId?: string; email?: string }): Promise<number> {
  const email = filter.email?.trim().toLowerCase();
  const candidates = [
    ...roomConnections().map((c) => ({ ws: c.ws, target: c.target, userEmail: c.userEmail, sessionId: c.sessionId, yjs: false })),
    ...yjsConnections().map((c) => ({ ws: c.ws, target: { kind: 'submission' as const, id: c.submissionId }, userEmail: c.userEmail, sessionId: c.sessionId, yjs: true })),
  ].filter((c) => c.sessionId &&
    (!filter.submissionId || (c.target.kind === 'submission' && c.target.id === filter.submissionId)) &&
    (!email || c.userEmail.toLowerCase() === email));

  let closed = 0;
  for (const c of candidates) {
    try {
      const session = await GetSession(c.sessionId!, env);
      const user = session ? await getUser((session.data as { email: string }).email, env) : null;
      const access = user ? await roomAccess(c.target, user, env) : null;
      if (access?.ok) continue;
      const [code, reason] = session ? [CLOSE_ACCESS_REMOVED, 'Access removed'] : [CLOSE_SESSION_ENDED, 'Session ended'];
      if (c.yjs) closeYjsConnection(c.ws, code, reason);
      else closeRoomConnection(c.ws, code, reason);
      closed += 1;
    } catch (error) {
      console.error('Could not check a room connection again:', error);
    }
  }
  return closed;
}

// Simple liveness check for the real-time endpoint.
router.get('/test', () => json({ status: 'ok', message: 'WebSocket infrastructure test passed' }));

// A plain GET on the upgrade paths is not a WebSocket handshake.
const expectUpgrade = () => json(
  { error: 'Expected WebSocket upgrade request' },
  { status: 426, headers: { 'Upgrade': 'websocket' } }
);
router.get('/submissions/:submissionId', expectUpgrade);
router.get('/documents/:documentId', expectUpgrade);
router.get('/yjs/submissions/:submissionId', expectUpgrade);

// There are deliberately no HTTP routes to broadcast into a room or list its
// members. The old POST .../broadcast and GET .../room routes only required a
// login, so any user could inject messages into any room or see who was in it,
// and the frontend never called them. Server code broadcasts with the functions
// below; clients join rooms through the (access-checked) upgrade.

// Utility function to broadcast messages from other parts of the application
export async function broadcastToSubmissionRoom(
  submissionId: string,
  message: Omit<WebSocketMessage, 'submissionId' | 'timestamp'>,
  _env: any
): Promise<void> {
  try {
    broadcastToRoom(submissionRoomKey(submissionId), {
      ...message,
      submissionId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Failed to broadcast message to submission room:', error);
  }
}

// Utility function to broadcast messages to document rooms
export async function broadcastToDocumentRoom(
  documentId: string,
  message: Omit<WebSocketMessage, 'documentId' | 'timestamp'>,
  _env: any
): Promise<void> {
  try {
    broadcastToRoom(documentRoomKey(documentId), {
      ...message,
      documentId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Failed to broadcast message to document room:', error);
  }
}
