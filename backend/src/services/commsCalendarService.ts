import { isCouncil } from './access';
import { CommsCalendarEntry, CommsMethod, ContentSubmission, User, UserType } from '../types';
import { Env } from '../utils/sessionManager';
import { getObject, getObjectStrict, putObject, deleteObject, listObjects } from './cacheService';
import { isAdminUser, isCommsCadre, isCommsManager } from './commsCadreService';
import { getUser } from './userService';
import { getTrackedChanges, TrackedChange } from './trackedChangesService';
import { approvedFieldValue } from './announcementEmail';
import { audienceKeys } from '../utils/audiences';
import { escapeHtml } from '../utils/lexicalEmail';
import { renderEmailHtml } from '../utils/email';
import { isValidYmd, addDays, daysBetween, toUtc } from '../utils/ymd';
import { cleanDateLinks, DateLinkError } from '../utils/dateLinks';

/**
 * Comms Calendar: the communications sent in each Sep→Aug cycle, so Comms can ask the
 * owning team ahead of the anniversary whether they want to send something similar.
 * One object per entry at comms_calendar/<id>; next year's version of an entry is a new
 * entry whose carriedFromId points at it.
 */

export const CALENDAR_PREFIX = 'comms_calendar/';
export const COMMS_METHODS: CommsMethod[] = ['Announce', 'Newsletter', 'Both', 'N/A'];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function listEntries(env: Env): Promise<CommsCalendarEntry[]> {
  const listing = await listObjects(CALENDAR_PREFIX, env);
  if (!listing?.objects) return [];
  const entries: CommsCalendarEntry[] = [];
  for (const obj of listing.objects) {
    const entry = await getObject<CommsCalendarEntry>(obj.key, env);
    if (entry) entries.push(entry);
  }
  return entries;
}

export async function getEntry(id: string, env: Env): Promise<CommsCalendarEntry | null> {
  return getObject<CommsCalendarEntry>(`${CALENDAR_PREFIX}${id}`, env);
}

export async function saveEntry(entry: CommsCalendarEntry, env: Env): Promise<void> {
  await putObject(`${CALENDAR_PREFIX}${entry.id}`, entry, env);
}

export async function deleteEntry(id: string, env: Env): Promise<void> {
  await deleteObject(`${CALENDAR_PREFIX}${id}`, env);
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const normalizeEmail = (email: string | undefined | null) => (email || '').trim().toLowerCase();

/**
 * Comms runs the calendar: Admins, Comms Cadre (by user type, role, or the active Comms
 * Cadre list) and the Council's Communications Manager can change it and send nudges.
 */
export async function canEditCalendar(user: User, env: Env): Promise<boolean> {
  return isAdminUser(user) || (await isCommsCadre(user, env)) || (await isCommsManager(user, env));
}

/** Everyone who can edit, plus the rest of Council (read only). */
export async function canViewCalendar(user: User, env: Env): Promise<boolean> {
  if (isCouncil(user)) return true;
  return canEditCalendar(user, env);
}

// ---------------------------------------------------------------------------
// Dates (all YYYY-MM-DD strings, calendar arithmetic in UTC)
// ---------------------------------------------------------------------------

export { isValidYmd, addDays, daysBetween };

/** The same month and day `years` later; Feb 29 becomes Feb 28 in a non-leap year. */
export function addYearsClamped(ymd: string, years: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = y + years;
  const lastDay = new Date(Date.UTC(target, m, 0)).getUTCDate();
  return `${target}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** The year a Sep→Aug cycle starts in: Sep–Dec belong to that year's cycle, Jan–Aug to the year before's. */
export function cycleStartYear(ymd: string): number {
  const [y, m] = ymd.split('-').map(Number);
  return m >= 9 ? y : y - 1;
}

/** The date an entry sorts by: target, else sent, else when it was added. */
export function anchorDate(entry: Pick<CommsCalendarEntry, 'targetDate' | 'dateSent' | 'createdAt'>): string {
  return entry.targetDate || entry.dateSent || (entry.createdAt || '').slice(0, 10);
}

/** The cycle (start year) an entry belongs to: from its dates, else its cycleYear, else when it was added. */
export function entryCycle(entry: Pick<CommsCalendarEntry, 'targetDate' | 'dateSent' | 'createdAt' | 'cycleYear'>): number {
  const dated = entry.targetDate || entry.dateSent;
  if (dated) return cycleStartYear(dated);
  return entry.cycleYear ?? cycleStartYear((entry.createdAt || new Date().toISOString()).slice(0, 10));
}

/** A sent time as a date in Pacific time, where Rangers' days happen. */
export function pacificDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

/** "September 14, 2025" */
export function formatLongDate(ymd: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
    .format(toUtc(ymd));
}

// ---------------------------------------------------------------------------
// Upcoming anniversaries
// ---------------------------------------------------------------------------

export interface UpcomingItem {
  entry: CommsCalendarEntry;
  /** YYYY-MM-DD */
  anniversary: string;
  /** Negative when the anniversary has passed (within the lookback). */
  daysUntil: number;
  overdue: boolean;
}

/**
 * The first anniversary of the entry's date (target, else sent) on or after
 * `today - lookback`, or null when the entry has no date.
 */
export function nextAnniversary(
  entry: Pick<CommsCalendarEntry, 'targetDate' | 'dateSent'>,
  today: string,
  lookback = 0,
): string | null {
  const base = entry.targetDate || entry.dateSent;
  if (!base) return null;
  const from = addDays(today, -lookback);
  let years = 1;
  let candidate = addYearsClamped(base, years);
  while (candidate < from) candidate = addYearsClamped(base, ++years);
  return candidate;
}

/**
 * Entries whose anniversary falls between `today - lookback` and `today + days` and that
 * nobody has dealt with yet: no later entry continues them and they aren't marked
 * "won't repeat". Nudged entries stay listed (with their nudges) until one of those happens.
 */
export function computeUpcoming(
  entries: CommsCalendarEntry[],
  today: string,
  days: number,
  lookback: number,
): UpcomingItem[] {
  const continued = new Set(entries.map((e) => e.carriedFromId).filter(Boolean));
  const until = addDays(today, days);
  const items: UpcomingItem[] = [];
  for (const entry of entries) {
    if (entry.notRepeating || continued.has(entry.id)) continue;
    const anniversary = nextAnniversary(entry, today, lookback);
    if (!anniversary || anniversary > until) continue;
    const daysUntil = daysBetween(today, anniversary);
    items.push({ entry, anniversary, daysUntil, overdue: daysUntil < 0 });
  }
  return items.sort((a, b) => a.anniversary.localeCompare(b.anniversary) || a.entry.subject.localeCompare(b.entry.subject));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The fields a client may set. null (or '') clears an optional field. */
export interface EntryInput {
  subject?: string;
  link?: string | null;
  targetDate?: string | null;
  dateSent?: string | null;
  cycleYear?: number | null;
  method?: CommsMethod;
  team?: string;
  contactEmails?: string[] | string;
  comments?: string;
  submissionId?: string | null;
  carriedFromId?: string | null;
  notRepeating?: boolean;
  documentText?: string | null;
  dateLinks?: CommsCalendarEntry['dateLinks'];
}

/** Validated fields; `null` means "remove this optional field". */
export type EntryPatch = {
  [K in keyof Omit<EntryInput, 'contactEmails'>]?: Exclude<EntryInput[K], string[] | ''> | null;
} & { contactEmails?: string[] };

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const LIMITS = { subject: 500, link: 2000, team: 200, comments: 5000, id: 200, contacts: 20, documentText: 200_000 };

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

/** Emails from an array or a comma/semicolon/space separated string, lowercased and deduplicated. */
export function splitEmails(value: string[] | string | undefined | null): string[] {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,;\s]+/);
  const seen = new Set<string>();
  for (const part of parts) {
    const email = normalizeEmail(typeof part === 'string' ? part : '');
    if (email) seen.add(email);
  }
  return [...seen];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Check a create (`partial` false: subject required) or update body. Returns the cleaned
 * fields or the first problem found.
 */
export function validateEntryInput(
  input: unknown,
  { partial }: { partial: boolean },
): { patch: EntryPatch; error?: undefined } | { patch?: undefined; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected a JSON object' };
  const body = input as Record<string, unknown>;
  const patch: EntryPatch = {};
  const has = (key: string) => body[key] !== undefined;
  const optionalString = (key: keyof EntryInput, max: number): string | null | undefined => {
    if (!has(key)) return undefined;
    const value = body[key];
    if (value === null || value === '') return null;
    if (typeof value !== 'string') throw new Error(`${key} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length > max) throw new Error(`${key} is too long (max ${max} characters)`);
    return trimmed || null;
  };

  try {
    if (has('subject') || !partial) {
      const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
      if (!subject) return { error: 'Subject is required' };
      if (subject.length > LIMITS.subject) return { error: `subject is too long (max ${LIMITS.subject} characters)` };
      patch.subject = subject;
    }

    const link = optionalString('link', LIMITS.link);
    if (link !== undefined) {
      if (link !== null && !isHttpUrl(link)) return { error: 'link must be an http(s) URL' };
      patch.link = link;
    }

    for (const key of ['targetDate', 'dateSent'] as const) {
      const value = optionalString(key, 10);
      if (value === undefined) continue;
      if (value !== null && !isValidYmd(value)) return { error: `${key} must be a date (YYYY-MM-DD)` };
      patch[key] = value;
    }

    if (has('cycleYear')) {
      const year = body.cycleYear;
      if (year !== null && (!Number.isInteger(year) || (year as number) < 2000 || (year as number) > 2100)) {
        return { error: 'cycleYear must be a year' };
      }
      patch.cycleYear = year as number | null;
    }

    if (has('method') || !partial) {
      const method = body.method ?? 'N/A';
      if (!COMMS_METHODS.includes(method as CommsMethod)) return { error: `method must be one of ${COMMS_METHODS.join(', ')}` };
      patch.method = method as CommsMethod;
    }

    for (const [key, max] of [['team', LIMITS.team], ['comments', LIMITS.comments]] as const) {
      if (!has(key) && partial) continue;
      const value = body[key] ?? '';
      if (typeof value !== 'string') return { error: `${key} must be a string` };
      if (value.trim().length > max) return { error: `${key} is too long (max ${max} characters)` };
      patch[key] = value.trim();
    }

    if (has('contactEmails') || !partial) {
      const raw = body.contactEmails;
      if (raw !== undefined && raw !== null && typeof raw !== 'string' && !Array.isArray(raw)) {
        return { error: 'contactEmails must be a list of emails' };
      }
      const emails = splitEmails(raw as string[] | string | undefined);
      const bad = emails.find((e) => !isValidEmail(e));
      if (bad) return { error: `Not an email address: ${bad}` };
      if (emails.length > LIMITS.contacts) return { error: `At most ${LIMITS.contacts} contact emails` };
      patch.contactEmails = emails;
    }

    for (const key of ['submissionId', 'carriedFromId'] as const) {
      const value = optionalString(key, LIMITS.id);
      if (value !== undefined) patch[key] = value;
    }

    if (has('notRepeating')) {
      if (typeof body.notRepeating !== 'boolean') return { error: 'notRepeating must be true or false' };
      patch.notRepeating = body.notRepeating;
    }

    if (has('documentText')) {
      const value = body.documentText;
      if (value !== null && typeof value !== 'string') return { error: 'documentText must be text' };
      const textValue = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
      if (textValue.length > LIMITS.documentText) return { error: `documentText is too long (max ${LIMITS.documentText} characters)` };
      patch.documentText = textValue || null;
    }

    if (has('dateLinks')) {
      const links = cleanDateLinks(body.dateLinks);
      if (links.some((l) => l.field !== 'body')) return { error: 'A calendar entry only links dates in its document' };
      patch.dateLinks = links.length ? links : null;
    }
  } catch (error) {
    if (error instanceof DateLinkError) return { error: error.message };
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { patch };
}

/** Apply a validated patch: null removes the field. */
export function applyPatch(entry: CommsCalendarEntry, patch: EntryPatch): CommsCalendarEntry {
  const next: Record<string, unknown> = { ...entry };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  if (next.notRepeating === false) delete next.notRepeating;
  return next as unknown as CommsCalendarEntry;
}

/** A new entry from validated fields. */
export function newEntry(
  patch: EntryPatch,
  createdBy: string,
  source: CommsCalendarEntry['source'],
  id: string = crypto.randomUUID(),
): CommsCalendarEntry {
  const now = new Date().toISOString();
  const base: CommsCalendarEntry = {
    id,
    subject: '',
    method: 'N/A',
    team: '',
    contactEmails: [],
    comments: '',
    nudges: [],
    source,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  return applyPatch(base, patch);
}

/** Two entries are the same communication when subject (ignoring case) and cycle match. */
export function duplicateKey(entry: Pick<CommsCalendarEntry, 'subject' | 'targetDate' | 'dateSent' | 'createdAt' | 'cycleYear'>): string {
  return `${entry.subject.trim().toLowerCase()}|${entryCycle(entry)}`;
}

// ---------------------------------------------------------------------------
// Submissions → calendar
// ---------------------------------------------------------------------------

/**
 * The calendar method for a request's audiences: the newsletter, a standalone announcement
 * ('singular'), or both. Anything else (Allcom, website, ...) is `fallback`.
 */
export function mapAudienceToMethod(keys: string[], fallback: CommsMethod = 'N/A'): CommsMethod {
  const newsletter = keys.includes('newsletter');
  const singular = keys.includes('singular');
  if (newsletter && singular) return 'Both';
  if (newsletter) return 'Newsletter';
  if (singular) return 'Announce';
  return fallback;
}

function formField(submission: ContentSubmission, id: string): unknown {
  return (submission.formFields || []).find((field) => field.id === id)?.value;
}

function validDate(iso: string | undefined): Date | null {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * Create or update the calendar entry for a submission, when it goes out on its own
 * (send-email, or marked sent) or in a newsletter edition. Subject (as approved), target
 * date, method and the date it first went out come from the submission every time; team
 * and contacts only fill in when empty, so what Comms typed is kept. Entries without a
 * submission work the same way, which is why the values are copied rather than read live.
 */
export async function syncCalendarFromSubmission(
  submission: ContentSubmission,
  env: Env,
  options: {
    subject?: string;
    fallbackMethod?: CommsMethod;
    by?: string;
    /** It went out in this Ranger News edition. */
    newsletter?: { number: number; sentAt: string };
  } = {},
): Promise<CommsCalendarEntry> {
  const linked = (await listEntries(env)).find((e) => e.submissionId === submission.id);
  // A fixed ID, so two sends close together can't make two entries
  const id = linked?.id ?? `sub-${submission.id}`;
  const existing = linked ?? (await getObjectStrict<CommsCalendarEntry>(`${CALENDAR_PREFIX}${id}`, env));
  const by = options.by || submission.sentBy || submission.submittedBy || 'system';
  const entry = existing ?? newEntry({}, by, 'submission', id);
  const alreadyLinked = entry.submissionId === submission.id;
  const changes: TrackedChange[] = await getTrackedChanges(submission.id, env).catch(() => []);

  entry.submissionId = submission.id;
  const subject = (options.subject || approvedFieldValue(changes, 'title', submission.title || '')).trim();
  if (subject) entry.subject = subject.slice(0, LIMITS.subject);
  const publishBy = formField(submission, 'publishBy');
  if (typeof publishBy === 'string' && isValidYmd(publishBy.slice(0, 10))) entry.targetDate = publishBy.slice(0, 10);

  // Date sent: the first time it went out (its own email or the edition). An entry linked
  // by hand loses whatever date it had before.
  const sentDates = [validDate(submission.sentAt), options.newsletter ? validDate(options.newsletter.sentAt) : null]
    .filter((d): d is Date => d !== null)
    .map((d) => pacificDate(d.toISOString()));
  if (alreadyLinked && entry.dateSent) sentDates.push(entry.dateSent);
  if (sentDates.length > 0) entry.dateSent = sentDates.sort()[0];

  if (options.newsletter) entry.newsletterSentIn = options.newsletter.number;
  const keys = audienceKeys(submission, changes);
  const fallback = options.fallbackMethod ?? (options.newsletter ? 'Newsletter' : entry.method ?? 'N/A');
  let method = mapAudienceToMethod(keys, fallback);
  // Went out both ways, whatever the audience said
  if (entry.newsletterSentIn && submission.announcementSent) method = 'Both';
  entry.method = method;

  if (!entry.team) {
    const owner = formField(submission, 'owner');
    if (typeof owner === 'string') entry.team = owner.trim().slice(0, LIMITS.team);
  }
  if (entry.contactEmails.length === 0) {
    const submitter = submission.submittedBy ? await getUser(submission.submittedBy, env) : null;
    const replyTo = formField(submission, 'replyToAddress');
    entry.contactEmails = splitEmails([submitter?.email || '', typeof replyTo === 'string' ? replyTo : ''])
      .filter(isValidEmail);
  }

  entry.updatedAt = new Date().toISOString();
  entry.updatedBy = by;
  await saveEntry(entry, env);
  return entry;
}

// ---------------------------------------------------------------------------
// Nudge email
// ---------------------------------------------------------------------------

const METHOD_PHRASE: Record<CommsMethod, string> = {
  Announce: 'Ranger Announce',
  Newsletter: 'the Ranger Newsletter',
  Both: 'Ranger Announce and the Ranger Newsletter',
  'N/A': '',
};

export interface NudgeEmail {
  subject: string;
  text: string;
  html: string;
}

/** "Would you like to send this again this year?" to a team. */
export function buildNudgeEmail(
  entry: CommsCalendarEntry,
  nudger: { name: string; email: string },
  options: { frontendUrl: string; today: string; note?: string },
): NudgeEmail {
  const team = entry.team || 'there';
  const lastDate = entry.dateSent || entry.targetDate;
  const anniversary = nextAnniversary(entry, options.today, 30);
  const requestUrl = `${options.frontendUrl.replace(/\/+$/, '')}/comms-request`;
  const via = METHOD_PHRASE[entry.method]
    + (entry.newsletterSentIn && (entry.method === 'Newsletter' || entry.method === 'Both') ? ` (Ranger News #${entry.newsletterSentIn})` : '');
  const signer = nudger.name || nudger.email;

  // Each paragraph as [text, html]; values people typed are escaped in the HTML
  const link = (url: string) => `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
  const paragraphs: Array<[string, string]> = [];
  paragraphs.push([`Hi ${team},`, `Hi ${escapeHtml(team)},`]);
  const sentPhrase = `${lastDate ? `Around this time last year (${formatLongDate(lastDate)})` : 'Last year'}, `
    + `${entry.team || 'your team'} sent "${entry.subject}"${via ? ` via ${via}` : ''}.`;
  paragraphs.push([sentPhrase, escapeHtml(sentPhrase)]);
  if (entry.link) {
    paragraphs.push([`Last year's message: ${entry.link}`, `Last year's message: ${link(entry.link)}`]);
  }
  const ask = 'Would you like to send something similar this year?'
    + (anniversary ? ` Going by last year, that would be around ${formatLongDate(anniversary)}.` : '')
    + ' If so, please submit a Comms Request at least a week before you want it to go out:';
  paragraphs.push([`${ask} ${requestUrl}`, `${escapeHtml(ask)} ${link(requestUrl)}`]);
  const skip = "If you'd rather skip it this year, or someone else owns it now, just reply to this email.";
  paragraphs.push([skip, escapeHtml(skip)]);
  if (options.note) {
    const note = `Note from ${signer}: ${options.note}`;
    paragraphs.push([note, escapeHtml(note)]);
  }
  paragraphs.push([`Thanks,\n${signer}, Ranger Comms`, `Thanks,\n${escapeHtml(signer)}, Ranger Comms`]);

  return {
    subject: `Planning ahead: "${entry.subject}" for this year?`,
    text: paragraphs.map(([text]) => text).join('\n\n'),
    html: renderEmailHtml(paragraphs.map(([, html]) => html).join('\n\n')),
  };
}
