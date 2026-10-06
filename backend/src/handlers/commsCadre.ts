import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { withAuth } from '../authWrappers';
import { Env } from '../utils/sessionManager';
import { commsCadrePeople } from '../services/peopleService';

/**
 * The Comms Cadre, read from people's records. Membership is set on the People page
 * (PUT /api/admin/people/:id/access).
 */
export const router = AutoRouter({ base: '/api/comms-cadre' });

router.get('/', withAuth, async (_request: Request, env: Env) => {
  const people = await commsCadrePeople(env);
  return json(people.map((p) => ({ id: p.id, userId: p.id, email: p.email, name: p.name, active: true })));
});
