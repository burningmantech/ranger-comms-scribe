import { Env, sessionIndexKey } from '../utils/sessionManager';
import { getObjectStrict, putObject } from '../services/cacheService';

/**
 * Once: index the sessions made before `session-index/<user>/<id>` existed, so
 * DeleteSessionsForUser (which lists only a person's index) also finds them. Expired sessions
 * are deleted instead. The marker is written only after every session has been handled.
 */

export const MIGRATION_KEY = 'migrations/session-index-v1';

export interface SessionIndexMigrationResult {
  indexed: number;
  expired: number;
}

/** Run the migration once (at startup). Returns what it did, or null if it had run already. */
export async function migrateSessionIndex(env: Env): Promise<SessionIndexMigrationResult | null> {
  if (await getObjectStrict(MIGRATION_KEY, env)) return null;

  let indexed = 0;
  let expired = 0;
  const { objects } = await env.STORE.list('session/');
  for (const { key } of objects) {
    const sessionId = key.slice('session/'.length);
    if (!sessionId) continue;
    const object = await env.STORE.get(key);
    if (!object) continue;
    let session: { userId?: string; expiresAt?: number };
    try {
      session = await object.json() as { userId?: string; expiresAt?: number };
    } catch {
      continue; // unreadable: left to whoever looks at it, as before
    }
    if (typeof session.expiresAt === 'number' && session.expiresAt < Date.now()) {
      await env.STORE.delete(key);
      expired += 1;
      continue;
    }
    if (!session.userId) continue;
    await env.STORE.put(sessionIndexKey(session.userId, sessionId), '{}', { contentType: 'application/json' });
    indexed += 1;
  }

  await putObject(MIGRATION_KEY, { ranAt: new Date().toISOString(), indexed, expired }, env);
  console.log(`🔑 session-index: indexed ${indexed}, deleted ${expired} expired`);
  return { indexed, expired };
}
