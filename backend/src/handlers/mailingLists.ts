import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { User } from '../types';
import { withAuth } from '../authWrappers';
import { Env } from '../utils/sessionManager';
import { isAdmin, isCommsCadre, isReviewer } from '../services/access';
import {
  MailingListError,
  createMailingList,
  deleteMailingList,
  listMailingLists,
  updateMailingList,
} from '../services/mailingListService';

/**
 * Mailing lists (Requests → Settings). Reviewers can read them (the Send view lists them); the
 * Comms Cadre and Admins manage them.
 */
export const router = AutoRouter({ base: '/api/mailing-lists' });

const userOf = (request: Request) => (request as any).user as User;
const canManage = (user: User, env: Env) => isAdmin(user, env) || isCommsCadre(user);

function handle(work: (request: Request, env: Env) => Promise<Response>) {
  return async (request: Request, env: Env) => {
    try {
      return await work(request, env);
    } catch (err) {
      if (err instanceof MailingListError) return json({ error: err.message }, { status: err.status });
      console.error('Mailing list request failed:', err);
      return json({ error: 'Something went wrong' }, { status: 500 });
    }
  };
}

router.get('/', withAuth, handle(async (request, env) => {
  const user = userOf(request);
  if (!isReviewer(user, env)) return json({ error: 'Access denied' }, { status: 403 });
  return json({ lists: await listMailingLists(env, { includeInactive: true }), canManage: canManage(user, env) });
}));

router.post('/', withAuth, handle(async (request, env) => {
  if (!canManage(userOf(request), env)) return json({ error: 'Only the Comms Cadre and Admins manage mailing lists' }, { status: 403 });
  const list = await createMailingList(await request.json().catch(() => ({})), userOf(request), env);
  return json({ list }, { status: 201 });
}));

router.put('/:id', withAuth, handle(async (request, env) => {
  if (!canManage(userOf(request), env)) return json({ error: 'Only the Comms Cadre and Admins manage mailing lists' }, { status: 403 });
  const list = await updateMailingList((request as any).params.id, await request.json().catch(() => ({})), env);
  return json({ list });
}));

router.delete('/:id', withAuth, handle(async (request, env) => {
  if (!canManage(userOf(request), env)) return json({ error: 'Only the Comms Cadre and Admins manage mailing lists' }, { status: 403 });
  await deleteMailingList((request as any).params.id, env);
  return json({ success: true });
}));
