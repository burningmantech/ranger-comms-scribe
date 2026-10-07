import { AppNotification, User } from '../types';
import { Env } from '../utils/sessionManager';
import { deleteObject, getObjectStrict, listObjects, putObject } from '../services/cacheService';

/**
 * Once: in-app notifications are stored under the recipient's lowercased email
 * (`notifications/<email>/<id>`). Some were written under the recipient's user id, which the
 * bell never read. Each of those moves to the person's email (userId set to it too).
 * Objects whose user can't be found are left where they are and reported. The marker is
 * written only after every object has been handled.
 */

export const MIGRATION_KEY = 'migrations/notifications-by-email-v1';
const PREFIX = 'notifications/';

export interface NotificationsMigrationResult {
  moved: number;
  /** Keys left alone because their user can't be found. */
  unresolved: string[];
}

/** Run the migration once (at startup). Returns what it did, or null if it had run already. */
export async function migrateNotificationsByEmail(env: Env): Promise<NotificationsMigrationResult | null> {
  if (await getObjectStrict(MIGRATION_KEY, env)) return null;

  // Who each id belongs to
  const emailById = new Map<string, string>();
  for (const object of (await listObjects('user/', env)).objects || []) {
    const user = await getObjectStrict<User>(object.key, env);
    if (user?.id && typeof user.email === 'string') emailById.set(user.id, user.email.toLowerCase());
  }

  let moved = 0;
  const unresolved: string[] = [];
  for (const object of (await listObjects(PREFIX, env)).objects || []) {
    const [, owner, id, ...rest] = String(object.key).split('/');
    if (!owner || !id || rest.length > 0) continue;
    if (owner.includes('@') && owner === owner.toLowerCase()) continue;

    const email = owner.includes('@') ? owner.toLowerCase() : emailById.get(owner);
    if (!email) {
      unresolved.push(object.key);
      continue;
    }
    const notification = await getObjectStrict<AppNotification>(object.key, env);
    if (!notification) continue;
    await putObject(`${PREFIX}${email}/${id}`, { ...notification, userId: email }, env);
    await deleteObject(object.key, env);
    moved++;
  }

  await putObject(MIGRATION_KEY, { at: new Date().toISOString(), moved, unresolved }, env);
  console.log(`🔔 notifications-by-email: moved ${moved}`);
  for (const key of unresolved) console.warn(`⚠️ notifications-by-email: no user for ${key}: left as it is`);
  return { moved, unresolved };
}
