/**
 * What the signed-in person can do: the frontend mirror of backend/src/services/access.ts. The
 * person's record (GET /auth/me) holds `isAdmin`, `commsCadre` and `councilRoles`; `userType`
 * and `roles` are derived from them. The backend decides every request; these only choose what
 * the UI offers.
 */

export interface PersonLike {
  isAdmin?: boolean;
  approved?: boolean;
  commsCadre?: boolean;
  councilRoles?: string[];
  accessVersion?: number;
  userType?: string;
  roles?: string[];
}

export interface Access {
  isAdmin: boolean;
  commsCadre: boolean;
  councilRoles: string[];
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
  return (user.accessVersion ?? 0) >= 1 || Array.isArray(user.councilRoles) || typeof user.commsCadre === 'boolean';
}

export function accessOf(user: PersonLike | null | undefined): Access {
  if (!user) return { isAdmin: false, commsCadre: false, councilRoles: [], council: false };
  const roles = Array.isArray(user.roles) ? user.roles : [];
  if (hasAccessFields(user)) {
    const councilRoles = Array.isArray(user.councilRoles) ? user.councilRoles : [];
    return { isAdmin: user.isAdmin === true, commsCadre: user.commsCadre === true, councilRoles, council: councilRoles.length > 0 };
  }
  // A stored user from before the access fields: the roles say it
  return {
    isAdmin: user.isAdmin === true || user.userType === 'Admin' || roles.includes('Admin'),
    commsCadre: user.userType === 'CommsCadre' || roles.includes('CommsCadre'),
    councilRoles: [],
    council: user.userType === 'CouncilManager' || roles.includes('CouncilManager'),
  };
}

export const isAdmin = (user: PersonLike | null | undefined) => accessOf(user).isAdmin;
export const isCommsCadre = (user: PersonLike | null | undefined) => accessOf(user).commsCadre;
export const isCouncil = (user: PersonLike | null | undefined) => accessOf(user).council;
export const isCommsManager = (user: PersonLike | null | undefined) => accessOf(user).councilRoles.includes('CommunicationsManager');

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
  return a.isAdmin || a.commsCadre || a.councilRoles.includes('CommunicationsManager');
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
