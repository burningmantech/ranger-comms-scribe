import { CouncilRole, UserType } from '../types';

/**
 * What a person can do. The only place that reads `isAdmin`, `commsCadre`, `councilRole`
 * (and, for older records, `councilRoles` / `userType` / `roles`).
 *
 * - Anyone signed in: submits requests and follows their own.
 * - Admin: the admin pages, overrides, everything.
 * - Comms Cadre: reviews requests, builds and sends the newsletter.
 * - Council (one council role each): approves requests; the Communications Manager approves newsletter editions.
 *
 * The flags are independent: one person can be Comms Cadre and Communications Manager.
 * `userType` and `roles` on a record are derived from them (`withDerivedAccess`).
 */

export const COUNCIL_ROLES: CouncilRole[] = Object.values(CouncilRole);

export interface Access {
  isAdmin: boolean;
  commsCadre: boolean;
  /** The one council role held, if any. */
  councilRole: CouncilRole | null;
  /** Holds a council role (a pre-migration CouncilManager may hold one without it being known). */
  council: boolean;
}

const asCouncilRole = (value: unknown): CouncilRole | null =>
  COUNCIL_ROLES.includes(value as CouncilRole) ? (value as CouncilRole) : null;

/** The council role on a record: `councilRole`, or the first of an older record's `councilRoles`. */
function storedCouncilRole(user: Person): CouncilRole | null {
  if (user.councilRole !== undefined) return asCouncilRole(user.councilRole);
  const legacy = Array.isArray(user.councilRoles) ? user.councilRoles : [];
  return legacy.map(asCouncilRole).find(Boolean) || null;
}

// Any stored person record (or a dev user); fields are read defensively
type Person = Record<string, any>;

/** Bootstrap admins (BOOTSTRAP_ADMIN_EMAILS) are always Admin. */
export interface AccessEnv {
  BOOTSTRAP_ADMIN_EMAILS?: string[];
}

export const normalizeEmail = (email: unknown): string => (typeof email === 'string' ? email.trim().toLowerCase() : '');

/** The record holds the access fields (new users, People page edits, the migration). */
export function hasAccessFields(user: Person | null | undefined): boolean {
  return !!user && ((user.accessVersion ?? 0) >= 1 || 'councilRole' in user || Array.isArray(user.councilRoles) || typeof user.commsCadre === 'boolean');
}

/** A verified owner of a BOOTSTRAP_ADMIN_EMAILS address (unverified, anyone could have registered it). */
function isBootstrapAdmin(user: Person, env?: AccessEnv): boolean {
  const email = normalizeEmail(user.email);
  return !!email && user.verified === true && (env?.BOOTSTRAP_ADMIN_EMAILS || []).map(normalizeEmail).includes(email);
}

export function accessOf(user: Person | null | undefined, env?: AccessEnv): Access {
  if (!user) return { isAdmin: false, commsCadre: false, councilRole: null, council: false };
  const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
  const bootstrap = isBootstrapAdmin(user, env);
  if (hasAccessFields(user)) {
    const councilRole = storedCouncilRole(user);
    return {
      isAdmin: user.isAdmin === true || bootstrap,
      commsCadre: user.commsCadre === true,
      councilRole,
      council: councilRole !== null,
    };
  }
  // A record from before the migration (and the dev users): the type and roles say it
  const councilLegacy = user.userType === UserType.CouncilManager || roles.includes('CouncilManager');
  return {
    isAdmin: user.isAdmin === true || user.userType === UserType.Admin || bootstrap,
    commsCadre: user.userType === UserType.CommsCadre || roles.includes('CommsCadre'),
    councilRole: null,
    council: councilLegacy,
  };
}

export const isAdmin = (user: Person | null | undefined, env?: AccessEnv) => accessOf(user, env).isAdmin;
export const isCommsCadre = (user: Person | null | undefined) => accessOf(user).commsCadre;
export const isCouncil = (user: Person | null | undefined) => accessOf(user).council;
export const hasCouncilRole = (user: Person | null | undefined, role: CouncilRole) => accessOf(user).councilRole === role;
export const isCommsManager = (user: Person | null | undefined) => hasCouncilRole(user, CouncilRole.CommunicationsManager);
/** Admin, Comms Cadre or Council: sees and reviews every request. */
export function isReviewer(user: Person | null | undefined, env?: AccessEnv): boolean {
  const a = accessOf(user, env);
  return a.isAdmin || a.commsCadre || a.council;
}

/** The legacy single type: the "highest" role. */
export function derivedUserType(access: Access): UserType {
  if (access.isAdmin) return UserType.Admin;
  if (access.council) return UserType.CouncilManager;
  if (access.commsCadre) return UserType.CommsCadre;
  return UserType.Member;
}

/** The legacy roles list: the roles held (or Member when none). */
export function derivedRoles(access: Access): string[] {
  const roles: string[] = [];
  if (access.isAdmin) roles.push('Admin');
  if (access.commsCadre) roles.push('CommsCadre');
  if (access.council) roles.push('CouncilManager');
  if (roles.length === 0) roles.push('Member');
  return roles;
}

/**
 * A record with the access fields set and `userType` / `roles` / `isAdmin` derived from them. The
 * older `approved` and `councilRoles` fields are dropped.
 */
export function withDerivedAccess<T extends Person>(user: T, access: Access = accessOf(user)): T {
  const { approved: _approved, councilRoles: _councilRoles, ...rest } = user;
  return {
    ...rest,
    isAdmin: access.isAdmin,
    commsCadre: access.commsCadre,
    councilRole: access.councilRole,
    userType: derivedUserType(access),
    roles: derivedRoles(access),
    accessVersion: 1,
  } as unknown as T;
}

/** Who an approval counts for: the roles the approver held when approving, or holds now. */
export function approverCounts(
  snapshot: { approverType?: string; approverRoles?: string[] },
  current?: Access | null,
): { council: boolean; commsCadre: boolean } {
  const roles = snapshot.approverRoles || [];
  return {
    council: snapshot.approverType === UserType.CouncilManager || roles.includes('CouncilManager') || !!current?.council,
    commsCadre: snapshot.approverType === UserType.CommsCadre || roles.includes('CommsCadre') || !!current?.commsCadre,
  };
}

/** The access fields as the API shows them. */
export function accessView(user: Person, env?: AccessEnv) {
  const a = accessOf(user, env);
  return { isAdmin: a.isAdmin, commsCadre: a.commsCadre, councilRole: a.councilRole };
}

/** A user record without secrets, for API responses. */
export function publicUser<T extends Person>(user: T): Omit<T, 'passwordHash'> {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

/** The privilege roles held (no Member), for GET /admin/user-roles. */
export function heldRoles(access: Access): string[] {
  return derivedRoles(access).filter((role) => role !== 'Member' && role !== 'Public');
}

/**
 * GET /admin/user-roles: the roles held and what the review UI may offer. Reviewers (Admin,
 * Comms Cadre, Council) get every review permission; everyone else none. The server still
 * decides each request.
 */
export function rolesResponse(user: Person, env?: AccessEnv): { roles: string[]; permissions: Record<string, boolean> } {
  const access = accessOf(user, env);
  const reviewer = access.isAdmin || access.commsCadre || access.council;
  return {
    roles: heldRoles(access),
    permissions: {
      canEdit: reviewer,
      canApprove: reviewer,
      canCreateSuggestions: reviewer,
      canApproveSuggestions: reviewer,
      canReviewSuggestions: reviewer,
      canViewFilteredSubmissions: reviewer,
    },
  };
}
