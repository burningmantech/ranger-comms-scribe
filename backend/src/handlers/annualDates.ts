import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { AnnualDate, User } from '../types';
import { Env } from '../utils/sessionManager';
import { withAuth } from '../authWrappers';
import { canEditCalendar } from '../services/commsCalendarService';
import {
  listAnnualDates, getAnnualDate, saveAnnualDate, deleteAnnualDate, canEditAnnualDate,
  validateAnnualDateInput, applyAnnualDatePatch, newAnnualDate,
} from '../services/annualDatesService';

// Annual dates: anyone signed in reads them and adds one when tracking a date in a request.
// Comms Calendar editors change and delete any entry; whoever added one may change it (not delete
// it: other requests may link to it).
export const router = AutoRouter({ base: '/api/annual-dates' });

const userOf = (request: Request) => (request as any).user as User;

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

const byName = (a: AnnualDate, b: AnnualDate) => a.name.localeCompare(b.name);

// GET /api/annual-dates — every entry, and whether this user may change all of them
router.get('/', withAuth, async (request: Request, env: Env) => {
  const entries = (await listAnnualDates(env)).sort(byName);
  return json({ entries, canEditAll: await canEditCalendar(userOf(request), env) });
});

// POST /api/annual-dates — add one (usually tracking a date found in a request)
router.post('/', withAuth, async (request: Request, env: Env) => {
  const result = validateAnnualDateInput(await readBody(request), { partial: false });
  if (result.error !== undefined) return json({ error: result.error }, { status: 400 });
  const entry = newAnnualDate(result.patch, userOf(request).email);
  await saveAnnualDate(entry, env);
  return json(entry, { status: 201 });
});

// PUT /api/annual-dates/:id — change the rule, times, overrides, ...; every linked request sees it
router.put('/:id', withAuth, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  const existing = await getAnnualDate(id, env);
  if (!existing) return json({ error: 'Annual date not found' }, { status: 404 });
  if (!(await canEditAnnualDate(userOf(request), existing, env))) return json({ error: 'Forbidden' }, { status: 403 });
  const result = validateAnnualDateInput(await readBody(request), { partial: true });
  if (result.error !== undefined) return json({ error: result.error }, { status: 400 });
  delete result.patch.createdFrom;
  const entry = applyAnnualDatePatch(existing, result.patch);
  entry.updatedAt = new Date().toISOString();
  entry.updatedBy = userOf(request).email;
  await saveAnnualDate(entry, env);
  return json(entry);
});

// DELETE /api/annual-dates/:id — Comms Calendar editors only; requests that linked it show the link as gone
router.delete('/:id', withAuth, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  const existing = await getAnnualDate(id, env);
  if (!existing) return json({ error: 'Annual date not found' }, { status: 404 });
  if (!(await canEditCalendar(userOf(request), env))) return json({ error: 'Forbidden' }, { status: 403 });
  await deleteAnnualDate(id, env);
  return json({ success: true });
});
