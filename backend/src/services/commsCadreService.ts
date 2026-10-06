import { User } from '../types';
import { Env } from '../utils/sessionManager';
import * as access from './access';
import { commsCadrePeople, commsManagerPeople } from './peopleService';

/** The Comms Cadre and the Communications Manager, from people's records (services/access.ts). */

/** The emails (lowercased) of the Comms Cadre. */
export async function getActiveCommsCadreEmails(env: Env): Promise<Set<string>> {
  return new Set((await commsCadrePeople(env)).map((p) => access.normalizeEmail(p.email)));
}

/** The emails (lowercased) of the Communications Manager(s). */
export async function getCommsManagerEmails(env: Env): Promise<Set<string>> {
  return new Set((await commsManagerPeople(env)).map((p) => access.normalizeEmail(p.email)));
}

export async function isCommsCadre(user: User, _env?: Env): Promise<boolean> {
  return access.isCommsCadre(user);
}

export async function isCommsManager(user: User, _env?: Env): Promise<boolean> {
  return access.isCommsManager(user);
}

export function isAdminUser(user: User, env?: Env): boolean {
  return access.isAdmin(user, env);
}
