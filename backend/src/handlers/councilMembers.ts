import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { withAuth } from '../authWrappers';
import { Env } from '../utils/sessionManager';
import { councilMemberEntries } from '../services/peopleService';

/**
 * Council members, read from people's records (one entry per council role held). Council
 * roles are set on the People page (PUT /api/admin/people/:id/access).
 */
export const router = AutoRouter({ base: '/api/council' });

router.get('/members', withAuth, async (_request: Request, env: Env) => {
  return json(await councilMemberEntries(env));
});
