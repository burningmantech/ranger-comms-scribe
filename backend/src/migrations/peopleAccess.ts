import { CouncilRole, User, UserType } from '../types';
import { Env } from '../utils/sessionManager';
import { getObject, getObjectStrict, listObjects, putObject } from '../services/cacheService';
import { saveUser } from '../services/userService';
import { Access, COUNCIL_ROLES, hasAccessFields, normalizeEmail, withDerivedAccess } from '../services/access';

/**
 * Once: give every person the access fields (services/access.ts) from where access used to
 * live (docs/plans/2026-10-06-people-and-roles.md):
 *
 * - isAdmin: `isAdmin`, or userType Admin
 * - commsCadre: userType CommsCadre, a CommsCadre role, or active on comms_cadre:active
 * - councilRoles: every council_members:role:<role> list and active council_member/<id> record
 *   naming them; plus their per-person council_members:<id>:<role> records (the old org chart
 *   wrote only those) while they are still a council manager by type or role
 * - approved: unchanged
 *
 * The old keys are left as they are. People already migrated are skipped.
 */

export const MIGRATION_KEY = 'migrations/people-access-v1';

export interface PersonResult {
  email: string;
  before: { userType?: string; roles?: string[]; isAdmin?: boolean; approved?: boolean };
  after: Pick<Access, 'approved' | 'isAdmin' | 'commsCadre' | 'councilRoles'>;
  sources: string[];
}

export interface MigrationPlan {
  people: PersonResult[];
  /** Records the migration can't place: shown to the operator, never silently dropped. */
  anomalies: string[];
  alreadyMigrated: number;
}

interface ListEntry {
  email?: string;
  userId?: string;
  active?: boolean;
  role?: string;
}

const isActive = (e: ListEntry | null | undefined) => !!e && e.active !== false;

function matches(entry: ListEntry, user: User): boolean {
  const email = normalizeEmail(entry.email);
  return (!!email && email === normalizeEmail(user.email)) || (!!entry.userId && entry.userId === user.id);
}

/** What the migration would do, without writing anything. */
export async function planPeopleAccess(env: Env): Promise<MigrationPlan> {
  const anomalies: string[] = [];
  const users: User[] = [];
  for (const object of (await listObjects('user/', env)).objects || []) {
    const user = await getObjectStrict<User>(object.key, env);
    if (user && typeof user.email === 'string') users.push(user);
  }

  const cadre = ((await getObject<ListEntry[]>('comms_cadre:active', env)) || []).filter(isActive);
  const roleLists = new Map<CouncilRole, ListEntry[]>();
  for (const role of COUNCIL_ROLES) {
    roleLists.set(role, ((await getObject<ListEntry[]>(`council_members:role:${role}`, env)) || []).filter(isActive));
  }
  const legacy: ListEntry[] = [];
  for (const object of (await listObjects('council_member/', env)).objects || []) {
    const entry = await getObject<ListEntry>(object.key, env);
    if (isActive(entry)) legacy.push(entry!);
  }

  // Entries that name nobody we know
  const known = (e: ListEntry) => users.some((u) => matches(e, u));
  for (const e of cadre) if (!known(e)) anomalies.push(`Comms Cadre list names ${e.email || e.userId}, who has no account: ignored`);
  for (const [role, list] of roleLists) {
    for (const e of list) if (!known(e)) anomalies.push(`${role} list names ${e.email || e.userId}, who has no account: ignored`);
  }

  const people: PersonResult[] = [];
  let alreadyMigrated = 0;
  for (const user of users) {
    if (hasAccessFields(user)) {
      alreadyMigrated++;
      continue;
    }
    const roles = Array.isArray(user.roles) ? user.roles : [];
    const sources: string[] = [];

    const isAdmin = user.isAdmin === true || user.userType === UserType.Admin;
    if (isAdmin) sources.push(user.isAdmin === true ? 'isAdmin' : 'type Admin');

    let commsCadre = false;
    if (user.userType === UserType.CommsCadre) { commsCadre = true; sources.push('type CommsCadre'); }
    if (roles.includes('CommsCadre')) { commsCadre = true; sources.push('role CommsCadre'); }
    if (cadre.some((e) => matches(e, user))) { commsCadre = true; sources.push('Comms Cadre list'); }

    const councilRoles = new Set<CouncilRole>();
    for (const [role, list] of roleLists) {
      if (list.some((e) => matches(e, user))) { councilRoles.add(role); sources.push(`${role} list`); }
    }
    for (const e of legacy) {
      if (matches(e, user) && COUNCIL_ROLES.includes(e.role as CouncilRole)) {
        councilRoles.add(e.role as CouncilRole);
        sources.push(`${e.role} record`);
      }
    }
    const councilByType = user.userType === UserType.CouncilManager || roles.includes('CouncilManager');
    for (const role of COUNCIL_ROLES) {
      const own = await getObject<ListEntry>(`council_members:${user.id}:${role}`, env);
      if (!isActive(own) || councilRoles.has(role)) continue;
      if (councilByType) {
        councilRoles.add(role);
        sources.push(`${role} per-person record`);
      } else {
        anomalies.push(`${user.email}: an old ${role} per-person record, but no longer a council manager by type, role or list: not given ${role}`);
      }
    }
    if (councilByType && councilRoles.size === 0) {
      anomalies.push(`${user.email}: a council manager by type or role, but no council role is recorded anywhere: not on Council now (give them a role on the People page)`);
    }

    people.push({
      email: user.email,
      before: { userType: user.userType, roles, isAdmin: user.isAdmin, approved: user.approved },
      after: { approved: user.approved === true, isAdmin, commsCadre, councilRoles: Array.from(councilRoles) },
      sources,
    });
  }
  return { people, anomalies, alreadyMigrated };
}

/** Run the migration once (at startup). Returns the plan it applied, or null if it had run already. */
export async function migratePeopleAccess(env: Env): Promise<MigrationPlan | null> {
  if (await getObjectStrict(MIGRATION_KEY, env)) return null;
  const plan = await planPeopleAccess(env);
  for (const person of plan.people) {
    // Re-read: the person may have changed since planning
    const user = await getObjectStrict<User>(`user/${person.email}`, env);
    if (!user || hasAccessFields(user)) continue;
    const access: Access = { ...person.after, council: person.after.councilRoles.length > 0 };
    await saveUser(withDerivedAccess(user, access) as User, env);
  }
  await putObject(MIGRATION_KEY, {
    at: new Date().toISOString(),
    migrated: plan.people.length,
    alreadyMigrated: plan.alreadyMigrated,
    anomalies: plan.anomalies,
  }, env);
  for (const person of plan.people) {
    const a = person.after;
    const held = [a.isAdmin && 'Admin', a.commsCadre && 'Comms Cadre', ...a.councilRoles].filter(Boolean).join(', ') || (a.approved ? 'approved' : 'awaiting approval');
    console.log(`👥 people-access: ${person.email}: ${held}`);
  }
  for (const anomaly of plan.anomalies) console.warn(`⚠️ people-access: ${anomaly}`);
  return plan;
}
