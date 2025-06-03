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

  const userData = session.data as { email: string; name: string };
  const userIsAdmin = await isAdmin(userData.email, env);
  if (!userIsAdmin) {
    return json({ error: 'Unauthorized: Admin access required' }, { status: 403 });
  }

  // Add user data to request for use in route handlers
  request.user = session.userId;
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

  // Add user data to request for use in route handlers
  request.user = session.userId;
};

// Middleware to check if the user is authenticated
export const withAuth = async (request: Request, env: Env) => {
  console.log('withAuth called');
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await GetSession(sessionId, env);
  if (!session) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userData = session.data as { email: string; name: string };
  const user = await getUser(userData.email, env);
  if (!user) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

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
    request.user = session.userId;
    return; // Admins have access to everything
  }

  // Check if user can access this group
  const hasAccess = await canAccessGroup(session.userId, groupId, env);
  if (!hasAccess) {
    return json({ error: 'You do not have access to this group content' }, { status: 403 });
  }

  // Add user data to request for use in route handlers
  request.user = session.userId;
};
