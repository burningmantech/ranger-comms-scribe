import { CouncilRole, User, UserType } from '../types';
import { Env } from '../utils/sessionManager';
import { getObject } from './cacheService';
import { getCouncilManagersForRole } from './councilManagerService';

const normalize = (email: string | undefined | null) => (email || '').trim().toLowerCase();

/** The emails (lowercased) of the active Comms Cadre members (comms_cadre:active). */
export async function getActiveCommsCadreEmails(env: Env): Promise<Set<string>> {
  const members = (await getObject<any[]>('comms_cadre:active', env)) || [];
  return new Set(members.filter((m) => m && m.active).map((m) => normalize(m.email)).filter(Boolean));
}

/** Comms Cadre by user type, by role, or by membership of the active list. */
export async function isCommsCadre(user: User, env: Env): Promise<boolean> {
  if (user.userType === UserType.CommsCadre) return true;
  if ((user.roles || []).includes('CommsCadre')) return true;
  return (await getActiveCommsCadreEmails(env)).has(normalize(user.email));
}

/** The emails (lowercased) of the Council Communications Manager(s). */
export async function getCommsManagerEmails(env: Env): Promise<Set<string>> {
  const members = await getCouncilManagersForRole(CouncilRole.CommunicationsManager, env).catch(() => []);
  return new Set((members || []).filter((m) => m && m.active !== false).map((m) => normalize(m.email)).filter(Boolean));
}

export async function isCommsManager(user: User, env: Env): Promise<boolean> {
  return (await getCommsManagerEmails(env)).has(normalize(user.email));
}

export function isAdminUser(user: User): boolean {
  return user.userType === UserType.Admin || user.isAdmin === true;
}
