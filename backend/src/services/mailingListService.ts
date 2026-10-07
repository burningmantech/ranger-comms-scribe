import { MailingList, User } from '../types';
import { Env } from '../utils/sessionManager';
import { getObject, getObjectStrict, putObject, deleteObject, listObjects } from './cacheService';
import { AUDIENCE_LABELS } from '../utils/audiences';

/**
 * Mailing lists approved announcements can be sent to (e.g. ranger-intake-cadre@burningman.org).
 * Stored at mailing_lists/<id>, managed by the Comms Cadre and Admins. Ranger Announce is a
 * built-in list from ANNOUNCE_EMAIL_TO, so dev and staging keep their own announce address.
 */

const PREFIX = 'mailing_lists/';
export const ANNOUNCE_LIST_ID = 'announce';
/** Audiences that suggest Ranger Announce when sending. */
const ANNOUNCE_AUDIENCES = ['singular', 'newsletter'];

export class MailingListError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

function announceList(env: Env): MailingList | null {
  if (!env.ANNOUNCE_EMAIL_TO) return null;
  return {
    id: ANNOUNCE_LIST_ID,
    name: 'Ranger Announce',
    address: env.ANNOUNCE_EMAIL_TO,
    description: 'Announcements to all Rangers (set by the deployment, not editable here)',
    audiences: ANNOUNCE_AUDIENCES,
    active: true,
    createdBy: 'system',
    createdAt: '',
    updatedAt: '',
    builtIn: true,
  };
}

/** Every list, Ranger Announce first, then by name. */
export async function listMailingLists(env: Env, options: { includeInactive?: boolean } = {}): Promise<MailingList[]> {
  const stored: MailingList[] = [];
  for (const object of (await listObjects(PREFIX, env)).objects || []) {
    const list = await getObject<MailingList>(object.key, env);
    if (list && (options.includeInactive || list.active)) stored.push(list);
  }
  stored.sort((a, b) => a.name.localeCompare(b.name));
  const announce = announceList(env);
  return announce ? [announce, ...stored] : stored;
}

/**
 * The lists to tick by default for a request with these audience keys: the lists that serve one
 * of its audiences, else Ranger Announce (where every announcement went before lists existed).
 */
export function suggestedListIds(lists: MailingList[], audiences: string[]): string[] {
  const matching = lists.filter((l) => l.active && l.audiences.some((a) => audiences.includes(a))).map((l) => l.id);
  if (matching.length > 0) return matching;
  return lists.some((l) => l.id === ANNOUNCE_LIST_ID) ? [ANNOUNCE_LIST_ID] : [];
}

function clean(input: any, existing?: MailingList): Pick<MailingList, 'name' | 'address' | 'description' | 'audiences' | 'active'> {
  const name = typeof input.name === 'string' ? input.name.trim() : existing?.name || '';
  if (!name) throw new MailingListError(400, 'Give the list a name');
  if (name.length > 120) throw new MailingListError(400, 'The name is too long');
  const address = typeof input.address === 'string' ? input.address.trim() : existing?.address || '';
  if (!ADDRESS.test(address)) throw new MailingListError(400, 'The address must be an email address, like ranger-intake-cadre@burningman.org');
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 500) : existing?.description;
  let audiences = existing?.audiences || [];
  if (input.audiences !== undefined) {
    if (!Array.isArray(input.audiences)) throw new MailingListError(400, 'audiences must be a list');
    audiences = Array.from(new Set(input.audiences.filter((a: unknown) => typeof a === 'string' && a in AUDIENCE_LABELS))) as string[];
  }
  const active = typeof input.active === 'boolean' ? input.active : existing?.active ?? true;
  return { name, address, ...(description ? { description } : {}), audiences, active };
}

async function assertAddressFree(address: string, id: string | null, env: Env): Promise<void> {
  const lower = address.toLowerCase();
  const clash = (await listMailingLists(env, { includeInactive: true }))
    .find((l) => l.id !== id && l.address.toLowerCase() === lower);
  if (clash) throw new MailingListError(409, `${clash.name} already uses ${clash.address}`);
}

export async function createMailingList(input: any, user: User, env: Env): Promise<MailingList> {
  const fields = clean(input || {});
  await assertAddressFree(fields.address, null, env);
  const now = new Date().toISOString();
  const list: MailingList = { id: crypto.randomUUID(), ...fields, createdBy: user.email, createdAt: now, updatedAt: now };
  await putObject(`${PREFIX}${list.id}`, list, env);
  return list;
}

export async function updateMailingList(id: string, input: any, env: Env): Promise<MailingList> {
  if (id === ANNOUNCE_LIST_ID) throw new MailingListError(400, 'Ranger Announce is set by the deployment');
  const existing = await getObjectStrict<MailingList>(`${PREFIX}${id}`, env);
  if (!existing) throw new MailingListError(404, 'Mailing list not found');
  const fields = clean(input || {}, existing);
  await assertAddressFree(fields.address, id, env);
  const list: MailingList = { ...existing, ...fields, updatedAt: new Date().toISOString() };
  await putObject(`${PREFIX}${id}`, list, env);
  return list;
}

export async function deleteMailingList(id: string, env: Env): Promise<void> {
  if (id === ANNOUNCE_LIST_ID) throw new MailingListError(400, 'Ranger Announce is set by the deployment');
  const existing = await getObjectStrict<MailingList>(`${PREFIX}${id}`, env);
  if (!existing) throw new MailingListError(404, 'Mailing list not found');
  await deleteObject(`${PREFIX}${id}`, env);
}
