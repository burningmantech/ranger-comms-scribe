/**
 * What the signed-in person can do: the frontend mirror of backend/src/services/access.ts. The
 * person's record (GET /auth/me) holds `isAdmin`, `commsCadre` and `councilRole` (one, or null);
 * `userType` and `roles` are derived from them. Anyone signed in can submit requests. The backend decides every request; these only choose what
 * the UI offers.
 */

export interface PersonLike {
  isAdmin?: boolean;
  commsCadre?: boolean;
  councilRole?: string | null;
  /** Older records (and a signed-in user saved before the change): read as their first role. */
  councilRoles?: string[];
  accessVersion?: number;
  userType?: string;
  roles?: string[];
}

export interface Access {
  isAdmin: boolean;
  commsCadre: boolean;
  councilRole: string | null;
  council: boolean;
}

export const COUNCIL_ROLES: Array<{ id: string; label: string }> = [
  { id: 'CommunicationsManager', label: 'Communications Manager' },
  { id: 'IntakeManager', label: 'Intake Manager' },
  { id: 'LogisticsManager', label: 'Logistics Manager' },
  { id: 'OperationsManager', label: 'Operations Manager' },
  { id: 'PersonnelManager', label: 'Personnel Manager' },
  { id: 'DepartmentManager', label: 'Department Manager' },
  { id: 'DeputyDepartmentManager', label: 'Deputy Department Manager' },
];

export const councilRoleLabel = (id: string) => COUNCIL_ROLES.find((r) => r.id === id)?.label || id;

function hasAccessFields(user: PersonLike): boolean {
  return (user.accessVersion ?? 0) >= 1 || 'councilRole' in user || Array.isArray(user.councilRoles) || typeof user.commsCadre === 'boolean';
}

const isCouncilRole = (value: unknown): value is string => COUNCIL_ROLES.some((r) => r.id === value);

function storedCouncilRole(user: PersonLike): string | null {
  if (user.councilRole !== undefined) return isCouncilRole(user.councilRole) ? user.councilRole : null;
  return (Array.isArray(user.councilRoles) ? user.councilRoles : []).find(isCouncilRole) || null;
}

export function accessOf(user: PersonLike | null | undefined): Access {
  if (!user) return { isAdmin: false, commsCadre: false, councilRole: null, council: false };
  const roles = Array.isArray(user.roles) ? user.roles : [];
  if (hasAccessFields(user)) {
    const councilRole = storedCouncilRole(user);
    return { isAdmin: user.isAdmin === true, commsCadre: user.commsCadre === true, councilRole, council: councilRole !== null };
  }
  // A stored user from before the access fields: the roles say it
  return {
    isAdmin: user.isAdmin === true || user.userType === 'Admin' || roles.includes('Admin'),
    commsCadre: user.userType === 'CommsCadre' || roles.includes('CommsCadre'),
    councilRole: null,
    council: user.userType === 'CouncilManager' || roles.includes('CouncilManager'),
  };
}

export const isAdmin = (user: PersonLike | null | undefined) => accessOf(user).isAdmin;
export const isCommsCadre = (user: PersonLike | null | undefined) => accessOf(user).commsCadre;
export const isCouncil = (user: PersonLike | null | undefined) => accessOf(user).council;
export const isCommsManager = (user: PersonLike | null | undefined) => accessOf(user).councilRole === 'CommunicationsManager';

/** Admin, Comms Cadre or Council: sees and reviews every request. */
export function isReviewer(user: PersonLike | null | undefined): boolean {
  const a = accessOf(user);
  return a.isAdmin || a.commsCadre || a.council;
}

/** The review permissions object (GET /admin/user-roles shape): all or nothing. */
export function reviewerPermissions(reviewer: boolean) {
  return {
    canEdit: reviewer,
    canApprove: reviewer,
    canCreateSuggestions: reviewer,
    canApproveSuggestions: reviewer,
    canReviewSuggestions: reviewer,
    canViewFilteredSubmissions: reviewer,
  };
}

/** Can send an approved request to Announce: Comms Cadre or Admin. */
export function canSendAnnouncements(user: PersonLike | null | undefined): boolean {
  const a = accessOf(user);
  return a.isAdmin || a.commsCadre;
}

/** Sees the Newsletter pages: Comms Cadre, Admins, and the Communications Manager (to approve). */
export function canUseNewsletter(user: PersonLike | null | undefined): boolean {
  const a = accessOf(user);
  return a.isAdmin || a.commsCadre || a.councilRole === 'CommunicationsManager';
}

/** The signed-in user saved at sign-in (localStorage 'user'), or null. */
export function storedUser<T extends PersonLike = PersonLike & { id?: string; email?: string; name?: string }>(): T | null {
  try {
    const json = localStorage.getItem('user');
    return json ? (JSON.parse(json) as T) : null;
  } catch {
    return null;
  }
}
