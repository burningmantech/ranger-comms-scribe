import { CouncilRole, UserType } from '../types';

/**
 * The fake users of the local-only auth bypass (`DEV_BYPASS_AUTH=true`). Callers must
 * check `env.DEV_BYPASS_AUTH === 'true'` before using them; nothing here does.
 *
 * Which one a request gets: the `X-Dev-User` header (REST) or `testUser` query parameter
 * (WebSocket) when it names one ('user2', 'member', 'council'), else a session ID containing
 * that name ('dev-user2-session', 'dev-member-session', 'dev-council-session'), else the admin.
 */
export type DevUserKey = 'admin' | 'user2' | 'member' | 'council';

export interface DevUser {
  id: string;
  email: string;
  name: string;
  userType: UserType;
  isAdmin: boolean;
  roles: string[];
  groups: string[];
  commsCadre: boolean;
  councilRole: CouncilRole | null;
  accessVersion: number;
}

export const DEV_USERS: Record<DevUserKey, DevUser> = {
  admin: { id: 'dev-admin', email: 'dev@localhost', name: 'Dev Admin', userType: UserType.Admin, isAdmin: true, roles: ['Admin'], groups: [], commsCadre: false, councilRole: null, accessVersion: 1 },
  user2: { id: 'dev-user2', email: 'user2@localhost', name: 'Test Reviewer', userType: UserType.CommsCadre, isAdmin: false, roles: ['CommsCadre'], groups: [], commsCadre: true, councilRole: null, accessVersion: 1 },
  member: { id: 'dev-member', email: 'member@localhost', name: 'Test Member', userType: UserType.Member, isAdmin: false, roles: ['Member'], groups: [], commsCadre: false, councilRole: null, accessVersion: 1 },
  council: { id: 'dev-council', email: 'council@localhost', name: 'Test Council', userType: UserType.CouncilManager, isAdmin: false, roles: ['CouncilManager'], groups: [], commsCadre: false, councilRole: CouncilRole.IntakeManager, accessVersion: 1 },
};

export function devUserKey(sessionId?: string | null, hint?: string | null): DevUserKey {
  if (hint === 'member' || hint === 'user2' || hint === 'council') return hint;
  const session = sessionId || '';
  if (session.includes('member')) return 'member';
  if (session.includes('council')) return 'council';
  if (session.includes('user2')) return 'user2';
  return 'admin';
}

/** A fresh copy of the dev user for this session ID / hint (callers may mutate it). */
export function getDevUser(sessionId?: string | null, hint?: string | null): DevUser {
  const user = DEV_USERS[devUserKey(sessionId, hint)];
  return { ...user, roles: [...user.roles], groups: [...user.groups] };
}

/** The dev user for a REST request: `X-Dev-User` header, then the bearer token. */
export function getDevUserForRequest(request: Request): DevUser {
  const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '') || '';
  return getDevUser(sessionId, request.headers.get('X-Dev-User'));
}
