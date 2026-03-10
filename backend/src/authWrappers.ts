import { GetSession, Env } from './utils/sessionManager';
import { isAdmin, getUser, canAccessGroup } from './services/userService';
import { json } from 'itty-router-extras';
import { UserType, User } from './types';

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

  if (!user.isAdmin && user.userType !== UserType.Admin) {
    return json({ error: 'Unauthorized: Admin access required' }, { status: 403 });
  }

  // Set the full User object so handlers can access user properties
  (request as any).user = user;
};

// Middleware to check if the user is a Lead or Admin
export const withLeadCheck = async (request: Request, env: Env) => {
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sessionId) {
    return json({ error: 'Session ID is required' }, { status: 400 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  const user = await getUser(session.userId, env);
  if (!user) {
    return json({ error: 'User not found' }, { status: 403 });
  }

  if (user.userType !== UserType.Lead && user.userType !== UserType.Admin) {
    return json({ error: 'Unauthorized: Lead or Admin access required' }, { status: 403 });
  }

  // Set the full User object so handlers can access user properties
  (request as any).user = user;
};

// Middleware to check if the user is authenticated
export const withAuth = async (request: Request, env: Env) => {
  if (env.DEV_BYPASS_AUTH === 'true') {
    (request as any).user = { id: 'dev-admin', email: 'dev@localhost', name: 'Dev Admin', userType: UserType.Admin, isAdmin: true, roles: ['Admin'], groups: [] };
    return undefined;
  }

  console.log('withAuth called');
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get user by userId (which is the email, the R2 storage key)
  const user = await getUser(session.userId, env);
  if (!user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Set the full User object so handlers can access user.id, user.email, user.userType, etc.
  (request as any).user = user;
  return undefined;
};

// Middleware to check if the user can access a group's content
export const withGroupAccessCheck = async (request: Request, env: Env) => {
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  const groupId = (request as any).params.groupId;
  
  // If no group ID is provided, just check authentication
  if (!groupId) {
    return withAuth(request, env);
  }
  
  // If no session ID is provided, check if the content is public
  if (!sessionId) {
    // Check if the group content is public (implement this logic)
    // For now, require authentication for all group content
    return json({ error: 'Authentication required to access group content' }, { status: 401 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Session not found or expired' }, { status: 403 });
  }

  // Check if user is admin (admins can access everything)
  const user = await getUser(session.userId, env);
  if (!user) {
    return json({ error: 'User not found' }, { status: 403 });
  }

  if (user.userType === UserType.Admin) {
    (request as any).user = user;
    return; // Admins have access to everything
  }

  // Check if user can access this group
  const hasAccess = await canAccessGroup(session.userId, groupId, env);
  if (!hasAccess) {
    return json({ error: 'You do not have access to this group content' }, { status: 403 });
  }

  // Set the full User object so handlers can access user properties
  (request as any).user = user;
};
