import { UserType } from '../types';

/**
 * The fake users of the local-only auth bypass (`DEV_BYPASS_AUTH=true`). Callers must
 * check `env.DEV_BYPASS_AUTH === 'true'` before using them; nothing here does.
 *
 * Which one a request gets: the `X-Dev-User` header (REST) or `testUser` query parameter
 * (WebSocket) when it names one ('user2', 'member'), else a session ID containing that
 * name ('dev-user2-session', 'dev-member-session'), else the admin.
 */
export type DevUserKey = 'admin' | 'user2' | 'member';

export interface DevUser {
  id: string;
  email: string;
  name: string;
  userType: UserType;
  isAdmin: boolean;
  roles: string[];
  groups: string[];
}

export const DEV_USERS: Record<DevUserKey, DevUser> = {
  admin: { id: 'dev-admin', email: 'dev@localhost', name: 'Dev Admin', userType: UserType.Admin, isAdmin: true, roles: ['Admin'], groups: [] },
  user2: { id: 'dev-user2', email: 'user2@localhost', name: 'Test Reviewer', userType: UserType.CommsCadre, isAdmin: false, roles: ['CommsCadre'], groups: [] },
  member: { id: 'dev-member', email: 'member@localhost', name: 'Test Member', userType: UserType.Member, isAdmin: false, roles: ['Member'], groups: [] },
};

export function devUserKey(sessionId?: string | null, hint?: string | null): DevUserKey {
  if (hint === 'member' || hint === 'user2') return hint;
  const session = sessionId || '';
  if (session.includes('member')) return 'member';
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

/**
 * Body of GET /api/admin/user-roles for a dev user. The admin and user2 keep the reply the
 * bypass always gave (full rights, roles ['Admin']); the member gets what the real endpoint
 * computes for a Member: no roles and no permissions.
 */
export function devUserRolesResponse(user: DevUser): { roles: string[]; permissions: Record<string, boolean> } {
  if (user.userType === UserType.Member) {
    return {
      roles: [],
      permissions: {
        canEdit: false, canApprove: false, canCreateSuggestions: false, canApproveSuggestions: false,
        canReviewSuggestions: false, canViewFilteredSubmissions: false,
      },
    };
  }
  return { roles: ['Admin'], permissions: { canEdit: true, canApprove: true, canCreateSuggestions: true, canReviewTrackedChanges: true, canManageSubmissions: true } };
}
