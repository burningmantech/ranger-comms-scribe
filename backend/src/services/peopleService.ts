import { CouncilRole, CouncilMember, User } from '../types';
import { Env } from '../utils/sessionManager';
import { getAllUsers, getUser, getUserStrict, saveUser } from './userService';
import { Access, COUNCIL_ROLES, accessOf, accessView, normalizeEmail, withDerivedAccess } from './access';

/**
 * People and their access (services/access.ts). The person's record is the only place access
 * is stored; lists of who holds a role are read from the records.
 */

export class AccessChangeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface AccessPatch {
  isAdmin?: boolean;
  commsCadre?: boolean;
  /** The council role to hold, replacing any other; null for none. */
  councilRole?: CouncilRole | null;
}

export async function listPeople(env: Env): Promise<User[]> {
  return (await getAllUsers(env)).filter((u) => u && typeof u.email === 'string' && u.email);
}

/** Access of each email's person (lowercased email → access); unknown emails are left out. */
export async function accessByEmail(emails: string[], env: Env): Promise<Map<string, Access>> {
  const unique = Array.from(new Set(emails.map(normalizeEmail).filter(Boolean)));
  const out = new Map<string, Access>();
  await Promise.all(unique.map(async (email) => {
    const user = await getUser(email, env).catch(() => null);
    if (user) out.set(email, accessOf(user, env));
  }));
  return out;
}

/** Each email's person: their access and name (lowercased email → person); unknown emails are left out. */
export async function peopleByEmail(emails: string[], env: Env): Promise<Map<string, { access: Access; name: string }>> {
  const unique = Array.from(new Set(emails.map(normalizeEmail).filter(Boolean)));
  const out = new Map<string, { access: Access; name: string }>();
  await Promise.all(unique.map(async (email) => {
    const user = await getUser(email, env).catch(() => null);
    if (user) out.set(email, { access: accessOf(user, env), name: user.name || email });
  }));
  return out;
}

export interface PersonRef {
  id: string;
  name: string;
  email: string;
}

const ref = (u: User): PersonRef => ({ id: u.id, name: u.name || u.email.split('@')[0], email: u.email });

/** The people for whom `test` is true. */
export async function peopleWhere(env: Env, test: (access: Access) => boolean): Promise<PersonRef[]> {
  return (await listPeople(env))
    .filter((u) => test(accessOf(u, env)))
    .map(ref)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const commsCadrePeople = (env: Env) => peopleWhere(env, (a) => a.commsCadre);
export const commsManagerPeople = (env: Env) => peopleWhere(env, (a) => a.councilRole === CouncilRole.CommunicationsManager);

/**
 * Council members as the older `CouncilMember` shape (one entry each), for GET /council/members
 * (approver suggestions on the request form and review page, reminders).
 */
export async function councilMemberEntries(env: Env): Promise<CouncilMember[]> {
  const entries: CouncilMember[] = [];
  for (const user of await listPeople(env)) {
    const role = accessOf(user, env).councilRole;
    if (role) {
      entries.push({
        id: `${user.id}:${role}`,
        userId: user.id,
        role,
        email: user.email,
        name: user.name || user.email,
        active: true,
        createdAt: '',
        updatedAt: '',
      });
    }
  }
  return entries;
}

/** Admins who hold Admin by the flag (not only through BOOTSTRAP_ADMIN_EMAILS). */
async function flagAdmins(env: Env): Promise<User[]> {
  return (await listPeople(env)).filter((u) => accessOf(u).isAdmin);
}

/**
 * Change a person's access (People page). Refuses to remove the last Admin, so the admin pages
 * can't be locked; an Admin can't take Admin away from themselves.
 */
export async function setAccess(targetId: string, patch: AccessPatch, actor: User, env: Env): Promise<User> {
  const user = await getUserStrict(targetId, env);
  if (!user) throw new AccessChangeError(404, 'Person not found');
  const current = accessOf(user);
  const next: Access = {
    isAdmin: patch.isAdmin ?? current.isAdmin,
    commsCadre: patch.commsCadre ?? current.commsCadre,
    councilRole: current.councilRole,
    council: current.council,
  };
  if (patch.councilRole !== undefined) {
    if (patch.councilRole !== null && !COUNCIL_ROLES.includes(patch.councilRole)) {
      throw new AccessChangeError(400, `The council role must be one of: ${COUNCIL_ROLES.join(', ')} (or null for none)`);
    }
    next.councilRole = patch.councilRole;
    next.council = patch.councilRole !== null;
  }

  if (current.isAdmin && !next.isAdmin) {
    if (normalizeEmail(actor.email) === normalizeEmail(user.email)) {
      throw new AccessChangeError(409, "You can't remove your own Admin. Ask another Admin.");
    }
    const others = (await flagAdmins(env)).filter((u) => normalizeEmail(u.email) !== normalizeEmail(user.email));
    if (others.length === 0) throw new AccessChangeError(409, "This is the only Admin; make someone else an Admin first.");
  }
  const updated = withDerivedAccess(user, next) as User;
  await saveUser(updated, env);
  return updated;
}

/** A person as the People page shows them. */
export function personView(user: User, env: Env) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    verified: user.verified === true,
    ...accessView(user, env),
  };
}
