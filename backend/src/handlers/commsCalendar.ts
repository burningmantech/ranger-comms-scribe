import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { CommsCalendarEntry, ContentSubmission, User } from '../types';
import { Env } from '../utils/sessionManager';
import { getObject } from '../services/cacheService';
import { withAuth } from '../authWrappers';
import { sendEmail } from '../utils/email';
import {
  listEntries, getEntry, saveEntry, deleteEntry, canEditCalendar, canViewCalendar,
  validateEntryInput, applyPatch, newEntry, duplicateKey, anchorDate, computeUpcoming,
  isValidYmd, splitEmails, isValidEmail, buildNudgeEmail, syncCalendarFromSubmission, pacificDate,
} from '../services/commsCalendarService';

// Comms Calendar: Comms Cadre, Admins and the Communications Manager edit and nudge;
// the rest of Council can look.
export const router = AutoRouter({ base: '/api/comms-calendar' });

const MAX_IMPORT_ROWS = 1000;
const MAX_UPCOMING_DAYS = 366;

const forbidden = () => json({ error: 'Forbidden' }, { status: 403 });
const userOf = (request: Request) => (request as any).user as User;

async function requireView(request: Request, env: Env): Promise<Response | undefined> {
  if (!(await canViewCalendar(userOf(request), env))) return forbidden();
}

async function requireEdit(request: Request, env: Env): Promise<Response | undefined> {
  if (!(await canEditCalendar(userOf(request), env))) return forbidden();
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function byAnchorDate(a: CommsCalendarEntry, b: CommsCalendarEntry): number {
  return anchorDate(a).localeCompare(anchorDate(b)) || a.subject.localeCompare(b.subject);
}

function intParam(value: string | null, fallback: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
}

// GET /api/comms-calendar — every entry, oldest first, and whether this user may edit
router.get('/', withAuth, requireView, async (request: Request, env: Env) => {
  const entries = (await listEntries(env)).sort(byAnchorDate);
  return json({ entries, canEdit: await canEditCalendar(userOf(request), env) });
});

// GET /api/comms-calendar/upcoming?days=42&lookback=14&today=YYYY-MM-DD
// Anniversaries coming up (or just passed) that no one has dealt with yet. The browser
// sends its own date as `today`; the server's Pacific date is the fallback.
router.get('/upcoming', withAuth, requireView, async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const todayParam = url.searchParams.get('today');
  const today = isValidYmd(todayParam) ? todayParam : pacificDate(new Date().toISOString());
  const days = intParam(url.searchParams.get('days'), 42, MAX_UPCOMING_DAYS);
  const lookback = intParam(url.searchParams.get('lookback'), 14, MAX_UPCOMING_DAYS);
  const items = computeUpcoming(await listEntries(env), today, days, lookback);
  return json({ items, today, days, lookback });
});

// POST /api/comms-calendar — add an entry
router.post('/', withAuth, requireEdit, async (request: Request, env: Env) => {
  const result = validateEntryInput(await readBody(request), { partial: false });
  if (result.error !== undefined) return json({ error: result.error }, { status: 400 });
  const entry = newEntry(result.patch, userOf(request).email, 'manual');
  await saveEntry(entry, env);
  return json(entry, { status: 201 });
});

// POST /api/comms-calendar/import — { entries: EntryInput[] } from the spreadsheet (CSV
// parsed in the browser). Rows already in the calendar (same subject and cycle), or
// repeated within the upload, are skipped, so importing the same file twice is harmless.
router.post('/import', withAuth, requireEdit, async (request: Request, env: Env) => {
  const body = (await readBody(request)) as { entries?: unknown } | undefined;
  const rows = body?.entries;
  if (!Array.isArray(rows)) return json({ error: 'Expected { entries: [...] }' }, { status: 400 });
  if (rows.length > MAX_IMPORT_ROWS) return json({ error: `At most ${MAX_IMPORT_ROWS} rows per import` }, { status: 400 });

  const user = userOf(request);
  const seen = new Set((await listEntries(env)).map(duplicateKey));
  const created: CommsCalendarEntry[] = [];
  const skipped: Array<{ index: number; reason: string }> = [];
  for (const [index, row] of rows.entries()) {
    const result = validateEntryInput(row, { partial: false });
    if (result.error !== undefined) {
      skipped.push({ index, reason: result.error });
      continue;
    }
    const entry = newEntry(result.patch, user.email, 'import');
    const key = duplicateKey(entry);
    if (seen.has(key)) {
      skipped.push({ index, reason: 'Already in the calendar' });
      continue;
    }
    seen.add(key);
    await saveEntry(entry, env);
    created.push(entry);
  }
  return json({ created: created.length, skipped, entries: created });
});

// POST /api/comms-calendar/from-submission/:submissionId — add (or refresh) the entry for
// a Scribe request; mainly for Newsletter items, which have no send of their own
router.post('/from-submission/:submissionId', withAuth, requireEdit, async (request: Request, env: Env) => {
  const { submissionId } = (request as any).params;
  const submission = await getObject<ContentSubmission>(`content_submissions/${submissionId}`, env);
  if (!submission) return json({ error: 'Submission not found' }, { status: 404 });
  const entry = await syncCalendarFromSubmission(submission, env, { by: userOf(request).email });
  return json(entry);
});

// PUT /api/comms-calendar/:id — change fields (nudges and creation details can't be set)
router.put('/:id', withAuth, requireEdit, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  const existing = await getEntry(id, env);
  if (!existing) return json({ error: 'Entry not found' }, { status: 404 });
  const result = validateEntryInput(await readBody(request), { partial: true });
  if (result.error !== undefined) return json({ error: result.error }, { status: 400 });
  if (result.patch.carriedFromId === id) return json({ error: 'An entry cannot continue itself' }, { status: 400 });
  const entry = applyPatch(existing, result.patch);
  entry.updatedAt = new Date().toISOString();
  entry.updatedBy = userOf(request).email;
  await saveEntry(entry, env);
  return json(entry);
});

// DELETE /api/comms-calendar/:id
router.delete('/:id', withAuth, requireEdit, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  if (!(await getEntry(id, env))) return json({ error: 'Entry not found' }, { status: 404 });
  await deleteEntry(id, env);
  return json({ success: true });
});

// POST /api/comms-calendar/:id/nudge — { to?: string[], note?: string }
// Ask the team whether they want to send it again this year. The nudge is logged only
// once the email has gone. NUDGE_EMAIL_OVERRIDE (dev, staging) redirects every nudge.
router.post('/:id/nudge', withAuth, requireEdit, async (request: Request, env: Env) => {
  const { id } = (request as any).params;
  const entry = await getEntry(id, env);
  if (!entry) return json({ error: 'Entry not found' }, { status: 404 });

  const body = ((await readBody(request)) || {}) as { to?: unknown; note?: unknown };
  const to = body.to === undefined ? entry.contactEmails : splitEmails(body.to as string[] | string);
  if (to.length === 0) return json({ error: 'No contact emails for this entry' }, { status: 400 });
  const bad = to.find((email) => !isValidEmail(email));
  if (bad) return json({ error: `Not an email address: ${bad}` }, { status: 400 });
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';

  const user = userOf(request);
  const nudger = { name: user.name || user.email, email: user.email };
  const email = buildNudgeEmail(entry, nudger, {
    frontendUrl: env.FRONTEND_URL || '',
    today: pacificDate(new Date().toISOString()),
    ...(note ? { note } : {}),
  });
  const recipients = env.NUDGE_EMAIL_OVERRIDE ? [env.NUDGE_EMAIL_OVERRIDE] : to;
  try {
    await sendEmail(recipients, email.subject, email.text, env, {
      html: email.html,
      text: email.text,
      ...(isValidEmail(user.email || '') ? { replyTo: user.email } : {}),
    });
  } catch (error) {
    console.error('Comms Calendar nudge failed:', error);
    return json({ error: error instanceof Error ? error.message : 'Failed to send email' }, { status: 502 });
  }

  // Re-read so an edit made while the email was sending isn't lost
  const latest = (await getEntry(id, env)) || entry;
  latest.nudges = [
    ...(latest.nudges || []),
    { at: new Date().toISOString(), by: user.email, byName: nudger.name, to, ...(note ? { note } : {}) },
  ];
  latest.updatedAt = new Date().toISOString();
  await saveEntry(latest, env);
  return json({ entry: latest, sentTo: recipients });
});
