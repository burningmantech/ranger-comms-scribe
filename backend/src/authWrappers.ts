import { GetSession, Env } from './utils/sessionManager';
import { getUser } from './services/userService';
import { isAdmin as accessIsAdmin } from './services/access';
import { json } from 'itty-router-extras';
import { User } from './types';
import { getDevUserForRequest } from './utils/devUsers';

// Middleware to check if the user is an admin
export const withAdminCheck = async (request: Request, env: Env) => {
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  // Look up the current user from storage (not stale session data) to get fresh role info
  const user = await getUser(session.userId, env);
  if (!user) {
    return json({ error: 'User not found' }, { status: 403 });
  }

  if (!accessIsAdmin(user, env)) {
    return json({ error: 'Unauthorized: Admin access required' }, { status: 403 });
  }

  // Set the full User object so handlers can access user properties
  (request as any).user = user;
};

// Middleware to check if the user is authenticated
export const withAuth = async (request: Request, env: Env) => {
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');

  // Try real session first
  if (sessionId) {
    const session = await GetSession(sessionId, env);
    if (session) {
      const user = await getUser(session.userId, env);
      if (user) {
        (request as any).user = user;
        return undefined;
      }
    }
  }

  // Fall back to dev bypass if no real session/user
  if (env.DEV_BYPASS_AUTH === 'true') {
    (request as any).user = getDevUserForRequest(request);
    return undefined;
  }

  return json({ error: 'Unauthorized' }, { status: 401 });
};
