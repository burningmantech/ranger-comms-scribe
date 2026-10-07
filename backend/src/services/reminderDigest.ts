import { ContentApproval, ContentSubmission } from '../types';
import { Env } from '../utils/sessionManager';
import { computeApprovalGates } from '../handlers/contentSubmission';
import { getObject, getObjectStrict, listObjects, putObject } from './cacheService';
import { createInAppNotification } from './notificationService';
import { commsCadrePeople } from './peopleService';
import { getUser } from './userService';
import { getAskLog } from './workflowNotifications';
import { formatPublishBy, renderWorkflowEmail, requestLink, sendWorkflowEmail, WorkflowEmailItem } from './workflowEmail';

/**
 * The daily reminder digest: one email a morning (Pacific time) per person, listing every
 * request that has been waiting on them for about a day or more. Run by an in-process timer;
 * the service is a single task.
 */

const TIME_ZONE = 'America/Los_Angeles';
/** The digest goes out from this Pacific hour on. */
const FIRST_HOUR = 8;
/** A request has to have waited at least this long. */
const MIN_WAIT_MS = 12 * 60 * 60 * 1000;
const MARKER_KEY = 'jobs/reminder-digest';

export const REASON_COUNCIL = 'Your approval (Council)';
export const REASON_APPROVER = 'Your approval';
export const REASON_COMMS_CADRE = 'A Comms Cadre approval';
export const REASON_CHOOSE_COUNCIL = 'Choose a council approver';
const REASON_ORDER = [REASON_COUNCIL, REASON_APPROVER, REASON_COMMS_CADRE, REASON_CHOOSE_COUNCIL];

export interface DigestItem {
  submissionId: string;
  title: string;
  reasons: string[];
  submitterName: string;
  /** YYYY-MM-DD as the requester wrote it, or null. */
  publishBy: string | null;
  /** When they were first asked, else when the request was submitted (ISO). */
  waitingSince: string;
}

export interface DigestSummary {
  /** The Pacific date of the run (YYYY-MM-DD). */
  date: string;
  dryRun: boolean;
  recipients: { email: string; count: number; titles: string[] }[];
  sent: number;
  failed: number;
}

const normalizeEmail = (email: string | undefined | null) => (email || '').trim().toLowerCase();

const pacificFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

function pacificParts(date: Date): { ymd: string; hour: number } {
  const parts: Record<string, string> = {};
  for (const p of pacificFormat.formatToParts(date)) parts[p.type] = p.value;
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** The Pacific calendar date (YYYY-MM-DD) of a moment. */
export const pacificDate = (date: Date): string => pacificParts(date).ymd;

const dayNumber = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86400000;

/** Publish By as a plain date, or null when it is empty or not a YYYY-MM-DD date. */
function publishByOf(submission: ContentSubmission): string | null {
  const value = (submission.formFields || []).find((f) => f.id === 'publishBy')?.value;
  const ymd = typeof value === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(value.trim())?.[0] : undefined;
  return ymd || null;
}

/** Who last rejected the request (lowercased emails); a rejection is a decision, so they aren't nagged. */
function rejectedBy(submission: ContentSubmission): Set<string> {
  const latest = new Map<string, ContentApproval>();
  for (const a of submission.approvals || []) {
    const key = normalizeEmail(a.approverEmail);
    if (!key) continue;
    const time = (x: ContentApproval) => new Date(x.updatedAt || x.createdAt).getTime();
    const prev = latest.get(key);
    if (!prev || time(a) >= time(prev)) latest.set(key, a);
  }
  return new Set(Array.from(latest).filter(([, a]) => a.status === 'rejected').map(([email]) => email));
}

/** Waited long enough: 12 hours or more, and since an earlier Pacific day than today. */
function waitedLongEnough(since: Date, now: Date): boolean {
  return now.getTime() - since.getTime() >= MIN_WAIT_MS && pacificDate(since) < pacificDate(now);
}

/**
 * Who each open request (submitted or in review) is waiting on, as one list of requests per
 * person (lowercased email), sorted by Publish By (none last), then longest waiting first.
 * Only people who haven't decided: an approval or a rejection takes a request off their list.
 */
export async function computeDigests(env: Env, now: Date): Promise<Map<string, DigestItem[]>> {
  const listing = await listObjects('content_submissions/', env);
  const submissions = (await Promise.all(
    (listing.objects || []).map((obj: { key: string }) => getObject<ContentSubmission>(obj.key, env).catch(() => null))
  )).filter((s): s is ContentSubmission => !!s && typeof s.id === 'string' && (s.status === 'submitted' || s.status === 'in_review'));

  const cadre = (await commsCadrePeople(env)).map((p) => normalizeEmail(p.email)).filter(Boolean);
  const names = new Map<string, string>();
  const out = new Map<string, DigestItem[]>();

  for (const submission of submissions) {
    try {
      const gates = await computeApprovalGates(submission, env);

      const submitter = submission.submittedBy ? await getUser(submission.submittedBy, env).catch(() => null) : null;
      const submitterEmail = normalizeEmail(submitter?.email || (submission.submittedBy?.includes('@') ? submission.submittedBy : ''));
      const submitterName = submitter?.name || submitter?.email || (submission.submittedBy?.includes('@') ? submission.submittedBy : '') || 'Unknown';
      names.set(submission.id, submitterName);

      const reasons = new Map<string, Set<string>>();
      const add = (email: string, reason: string) => {
        if (!email) return;
        if (!reasons.has(email)) reasons.set(email, new Set());
        reasons.get(email)!.add(reason);
      };

      for (const a of gates.councilManager.approvers) {
        if (a.status === 'pending') add(normalizeEmail(a.email), REASON_COUNCIL);
      }
      for (const a of gates.requiredApprovers.details) {
        if (a.status === 'pending') add(normalizeEmail(a.email), REASON_APPROVER);
      }
      const rejected = rejectedBy(submission);
      for (const email of cadre) {
        if (email === submitterEmail) continue;
        if (!gates.commsCadre.met && !rejected.has(email)) add(email, REASON_COMMS_CADRE);
        if (gates.councilManager.approvers.length === 0) add(email, REASON_CHOOSE_COUNCIL);
      }
      if (reasons.size === 0) continue;

      const asked = await getAskLog(env, submission.id);
      const submittedAt = new Date(submission.submittedAt);
      const validOr = (value: string | undefined) => {
        const date = new Date(value || '');
        return Number.isNaN(date.getTime()) ? submittedAt : date;
      };
      for (const [email, why] of reasons) {
        // The last ask decides whether they have waited long enough; the first is what they are shown
        const last = validOr(asked[email]?.last);
        const since = validOr(asked[email]?.first);
        if (Number.isNaN(last.getTime()) || Number.isNaN(since.getTime()) || !waitedLongEnough(last, now)) continue;
        const items = out.get(email) || [];
        items.push({
          submissionId: submission.id,
          title: submission.title,
          reasons: REASON_ORDER.filter((r) => why.has(r)),
          submitterName: names.get(submission.id) || 'Unknown',
          publishBy: publishByOf(submission),
          waitingSince: since.toISOString(),
        });
        out.set(email, items);
      }
    } catch (err) {
      console.error(`Reminder digest: could not work out who ${submission.id} is waiting on:`, err);
    }
  }

  for (const items of out.values()) {
    items.sort((a, b) => {
      if (a.publishBy !== b.publishBy) {
        if (!a.publishBy) return 1;
        if (!b.publishBy) return -1;
        return a.publishBy < b.publishBy ? -1 : 1;
      }
      return new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime();
    });
  }
  return out;
}

/** "Publish by Fri, Oct 9 (in 2 days)". */
function publishByLine(publishBy: string, now: Date): string {
  const days = dayNumber(publishBy) - dayNumber(pacificDate(now));
  const when = days < 0 ? 'overdue' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  return `Publish by ${formatPublishBy(publishBy)} (${when})`;
}

function digestEmail(env: Env, items: DigestItem[], now: Date) {
  const one = items.length === 1;
  const subject = one ? `"${items[0].title}" is waiting on you` : `${items.length} requests are waiting on you`;
  const emailItems: WorkflowEmailItem[] = items.map((item) => ({
    title: item.title,
    link: requestLink(env, item.submissionId),
    lines: [
      ...item.reasons,
      `Submitted by ${item.submitterName}`,
      ...(item.publishBy ? [publishByLine(item.publishBy, now)] : []),
      `Waiting since ${formatPublishBy(pacificDate(new Date(item.waitingSince)))}`,
    ],
  }));
  const site = requestLink(env, '').replace(/\/tracked-changes\/$/, '');
  const rendered = renderWorkflowEmail({
    heading: subject,
    paragraphs: ["Here's what's waiting on you in Comms Scribe."],
    items: emailItems,
    action: { label: 'See all requests', url: `${site}/requests` },
    footer: 'This is a daily reminder while requests are waiting on you.',
  });
  return { subject, rendered };
}

/**
 * Send each person their digest (unless `dryRun`). One email per person; a failure for one is
 * logged and the run goes on. The digest doesn't write the ask log: the
 * daily marker keeps it to once a day, and a manual Remind (which does) holds a request back.
 */
export async function runReminderDigest(env: Env, opts: { now?: Date; dryRun?: boolean } = {}): Promise<DigestSummary> {
  const now = opts.now || new Date();
  const dryRun = !!opts.dryRun;
  const digests = await computeDigests(env, now);
  const summary: DigestSummary = {
    date: pacificDate(now),
    dryRun,
    recipients: Array.from(digests)
      .map(([email, items]) => ({ email, count: items.length, titles: items.map((i) => i.title) }))
      .sort((a, b) => a.email.localeCompare(b.email)),
    sent: 0,
    failed: 0,
  };
  if (dryRun) return summary;

  for (const [email, items] of Array.from(digests).sort((a, b) => a[0].localeCompare(b[0]))) {
    let emailed = false;
    try {
      const { subject, rendered } = digestEmail(env, items, now);
      await sendWorkflowEmail(env, [email], subject, rendered);
      emailed = true;
      summary.sent++;
      await createInAppNotification({
        userId: email,
        type: 'reminder_digest',
        title: subject,
        message: items.length === 1 ? 'It is in your list of requests.' : items.slice(0, 3).map((i) => i.title).join(', ') + (items.length > 3 ? ', and more' : ''),
        link: '/requests',
      }, env);
    } catch (err) {
      if (!emailed) summary.failed++;
      console.error(`Reminder digest: ${emailed ? 'could not finish after sending to' : 'could not send to'} ${email}:`, err);
    }
  }
  return summary;
}

interface Marker {
  lastRunDate: string;
  startedAt: string;
  finishedAt?: string;
  summary?: DigestSummary;
  error?: string;
}

let running = false;

/**
 * Run the digest if it is the Pacific morning (8am or later) and today's hasn't run. The marker
 * is written before sending, so a restart or a second check can't send twice. Returns the
 * summary when it ran, else null.
 */
export async function checkReminderDigest(env: Env, now: Date = new Date()): Promise<DigestSummary | null> {
  if (env.REMINDER_DIGEST === 'off') return null;
  const { ymd, hour } = pacificParts(now);
  if (hour < FIRST_HOUR || running) return null;
  running = true;
  try {
    const marker = await getObjectStrict<Marker>(MARKER_KEY, env);
    if (marker?.lastRunDate === ymd) return null;
    const started: Marker = { lastRunDate: ymd, startedAt: now.toISOString() };
    await putObject(MARKER_KEY, started, env);
    try {
      const summary = await runReminderDigest(env, { now });
      await putObject(MARKER_KEY, { ...started, finishedAt: new Date().toISOString(), summary }, env);
      console.log(`Reminder digest ${ymd}: sent ${summary.sent}, failed ${summary.failed}`);
      return summary;
    } catch (err) {
      // Not retried today: the marker says it ran
      console.error('Reminder digest failed:', err);
      await putObject(MARKER_KEY, { ...started, error: String(err) }, env).catch(() => {});
      return null;
    }
  } catch (err) {
    console.error('Reminder digest check failed:', err);
    return null;
  } finally {
    running = false;
  }
}

/**
 * Check shortly after boot and then every hour. Off when REMINDER_DIGEST is "off".
 * Returns a function that stops the timers.
 */
export function startReminderDigestSchedule(
  env: Env,
  opts: { clock?: () => Date; firstCheckMs?: number; everyMs?: number } = {}
): () => void {
  if (env.REMINDER_DIGEST === 'off') {
    console.log('Reminder digest is off (REMINDER_DIGEST=off)');
    return () => {};
  }
  const clock = opts.clock || (() => new Date());
  const check = () => { void checkReminderDigest(env, clock()); };
  const first = setTimeout(check, opts.firstCheckMs ?? 60 * 1000);
  const every = setInterval(check, opts.everyMs ?? 60 * 60 * 1000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
