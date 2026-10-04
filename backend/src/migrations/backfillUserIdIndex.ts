import { Env } from '../utils/sessionManager';
import { User } from '../types';

/**
 * Migration: Create user-by-id/{uuid} → {email} index entries
 * for all existing users so lookups by UUID don't require scanning.
 */
export const backfillUserIdIndex = async (env: Env): Promise<void> => {
  try {
    const objects = await env.R2.list({ prefix: 'user/' });
    let created = 0;

    for (const object of objects.objects) {
      // Skip index entries themselves
      if (object.key.startsWith('user-by-id/')) continue;

      const userData = await env.R2.get(object.key);
      if (!userData) continue;

      const user = await userData.json() as User;
      if (!user.id || !user.email) continue;

      // Check if index already exists
      const existing = await env.R2.head(`user-by-id/${user.id}`);
      if (existing) continue;

      await env.R2.put(`user-by-id/${user.id}`, JSON.stringify({ email: user.email }), {
        httpMetadata: { contentType: 'application/json' }
      });
      created++;
    }

    if (created > 0) {
      console.log(`Backfilled ${created} user-by-id index entries`);
    }
  } catch (error) {
    console.error('Error backfilling user ID index:', error);
  }
};
