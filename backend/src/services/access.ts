import { CouncilRole, UserType } from '../types';

/**
 * What a person can do. The only place that reads `isAdmin`, `commsCadre`, `councilRoles`
 * (and, for records from before the people-access migration, `userType` / `roles`).
 *
 * - Admin: the admin pages, overrides, everything.
 * - Comms Cadre: reviews requests, builds and sends the newsletter.
 * - Council (any council role): approves requests; the Communications Manager approves newsletter editions.
 * - Approved: can sign in and submit requests.
 *
 * The flags are independent: one person can be Comms Cadre and Communications Manager.
 * `userType` and `roles` on a record are derived from them (`withDerivedAccess`).
 */

export const COUNCIL_ROLES: CouncilRole[] = Object.values(CouncilRole);

export interface Access {
  approved: boolean;
  isAdmin: boolean;
  commsCadre: boolean;
  councilRoles: CouncilRole[];
  /** Holds a council role (a pre-migration CouncilManager may hold one without it being known). */
  council: boolean;
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
  return !!user && ((user.accessVersion ?? 0) >= 1 || Array.isArray(user.councilRoles) || typeof user.commsCadre === 'boolean');
}

/** A verified owner of a BOOTSTRAP_ADMIN_EMAILS address (unverified, anyone could have registered it). */
function isBootstrapAdmin(user: Person, env?: AccessEnv): boolean {
  const email = normalizeEmail(user.email);
  return !!email && user.verified === true && (env?.BOOTSTRAP_ADMIN_EMAILS || []).map(normalizeEmail).includes(email);
}

export function accessOf(user: Person | null | undefined, env?: AccessEnv): Access {
  if (!user) return { approved: false, isAdmin: false, commsCadre: false, councilRoles: [], council: false };
  const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
  const bootstrap = isBootstrapAdmin(user, env);
  if (hasAccessFields(user)) {
    const councilRoles = (Array.isArray(user.councilRoles) ? user.councilRoles : [])
      .filter((r: any): r is CouncilRole => COUNCIL_ROLES.includes(r));
    return {
      approved: user.approved === true || bootstrap,
      isAdmin: user.isAdmin === true || bootstrap,
      commsCadre: user.commsCadre === true,
      councilRoles,
      council: councilRoles.length > 0,
    };
  }
  // A record from before the migration (and the dev users): the type and roles say it
  const councilLegacy = user.userType === UserType.CouncilManager || roles.includes('CouncilManager');
  return {
    approved: user.approved === true || bootstrap,
    isAdmin: user.isAdmin === true || user.userType === UserType.Admin || bootstrap,
    commsCadre: user.userType === UserType.CommsCadre || roles.includes('CommsCadre'),
    councilRoles: [],
    council: councilLegacy,
  };
}

export const isAdmin = (user: Person | null | undefined, env?: AccessEnv) => accessOf(user, env).isAdmin;
export const isCommsCadre = (user: Person | null | undefined) => accessOf(user).commsCadre;
export const isCouncil = (user: Person | null | undefined) => accessOf(user).council;
export const hasCouncilRole = (user: Person | null | undefined, role: CouncilRole) => accessOf(user).councilRoles.includes(role);
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
  return access.approved ? UserType.Member : UserType.Public;
}

/** The legacy roles list: the roles held (or Member / Public when none). */
export function derivedRoles(access: Access): string[] {
  const roles: string[] = [];
  if (access.isAdmin) roles.push('Admin');
  if (access.commsCadre) roles.push('CommsCadre');
  if (access.council) roles.push('CouncilManager');
  if (roles.length === 0) roles.push(access.approved ? 'Member' : 'Public');
  return roles;
}

/** A record with the access fields set and `userType` / `roles` / `isAdmin` derived from them. */
export function withDerivedAccess<T extends Person>(user: T, access: Access = accessOf(user)): T {
  return {
    ...user,
    approved: access.approved,
    isAdmin: access.isAdmin,
    commsCadre: access.commsCadre,
    councilRoles: [...access.councilRoles],
    userType: derivedUserType(access),
    roles: derivedRoles(access),
    accessVersion: 1,
  };
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
  return { approved: a.approved, isAdmin: a.isAdmin, commsCadre: a.commsCadre, councilRoles: a.councilRoles };
}

/** A user record without secrets, for API responses. */
export function publicUser<T extends Person>(user: T): Omit<T, 'passwordHash'> {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

/** The privilege roles held (no Member / Public), for GET /admin/user-roles. */
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
