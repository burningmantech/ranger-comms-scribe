import { AutoRouter, json } from 'itty-router';
import { withAuth } from '../authWrappers';
import { User, UserType } from '../types';
import { Env, GetSession } from '../utils/sessionManager';
import { getUser } from '../services/userService';
import { getObject } from '../services/cacheService';
import {
  RoomIdentity,
  RoomTarget,
  WebSocketMessage,
  broadcastToRoom,
  documentRoomKey,
  getRoomUsers,
  submissionRoomKey,
} from '../realtime/rooms';

/**
 * WebSocket upgrades for /api/ws/submissions/:id and /api/ws/documents/:id are
 * handled by the Node server's `upgrade` event (src/httpServer.ts), which calls
 * `authorizeRoomConnection` below and then joins the socket to a room in
 * src/realtime/rooms.ts. This router only sees plain HTTP requests.
 */
export const router = AutoRouter({ base: '/api/ws' });

export type RoomAuthResult =
  | { ok: true; identity: RoomIdentity }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Session and access checks for joining a room. Same semantics as the old Worker
 * handler:
 *   - 400 when `sessionId` is missing (even with DEV_BYPASS_AUTH);
 *   - with DEV_BYPASS_AUTH=true, no further checks (dev user, or user2 when
 *     `testUser=user2` or the session ID contains "user2");
 *   - 403 for an unknown/expired session or a user that no longer exists;
 *   - submissions only: 404 when the submission is missing, 403 without access.
 *
 * The room identity uses the email as `userId`, as before.
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
    const isUser2 = testUser === 'user2' || sessionId.includes('user2');
    const email = isUser2 ? 'user2@localhost' : 'dev@localhost';
    const name = isUser2 ? 'Test Reviewer' : 'Dev Admin';
    return { ok: true, identity: { userId: email, userName: name, userEmail: email } };
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

  if (target.kind === 'submission') {
    const submission = await getObject<any>(`content_submissions/${target.id}`, env);
    if (!submission) {
      return { ok: false, status: 404, body: { error: 'Submission not found' } };
    }

    const hasAccess = user.userType === UserType.Admin ||
      submission.submittedBy === user.id ||
      user.userType === UserType.CouncilManager ||
      user.userType === UserType.CommsCadre ||
      (submission.requiredApprovers && submission.requiredApprovers.includes(user.email));

    if (!hasAccess) {
      return { ok: false, status: 403, body: { error: 'Access denied' } };
    }
  }

  return {
    ok: true,
    identity: { userId: userData.email, userName: userData.name, userEmail: userData.email },
  };
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

function senderFields(user: User) {
  return {
    userId: user.id || user.email,
    userName: user.name,
    userEmail: user.email,
    timestamp: new Date().toISOString(),
  };
}

// HTTP API for broadcasting messages to WebSocket rooms
router.post('/submissions/:submissionId/broadcast', withAuth, async (request: Request) => {
  const { submissionId } = (request as any).params;
  const user = (request as any).user as User;
  const message = await request.json() as Record<string, unknown>;

  broadcastToRoom(submissionRoomKey(submissionId), { ...message, submissionId, ...senderFields(user) });
  return json({ success: true });
});

// Get room information (connected users)
router.get('/submissions/:submissionId/room', withAuth, (request: Request) => {
  const { submissionId } = (request as any).params;
  const roomId = submissionRoomKey(submissionId);
  const users = getRoomUsers(roomId);
  return json({ roomId, users, userCount: users.length });
});

router.post('/documents/:documentId/broadcast', withAuth, async (request: Request) => {
  const { documentId } = (request as any).params;
  const user = (request as any).user as User;
  const message = await request.json() as Record<string, unknown>;

  broadcastToRoom(documentRoomKey(documentId), { ...message, documentId, ...senderFields(user) });
  return json({ success: true });
});

router.get('/documents/:documentId/room', withAuth, (request: Request) => {
  const { documentId } = (request as any).params;
  const roomId = documentRoomKey(documentId);
  const users = getRoomUsers(roomId);
  return json({ roomId, users, userCount: users.length });
});

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
