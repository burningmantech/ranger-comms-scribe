import { FeedbackReport, FeedbackSettings, User } from '../types';
import { Env } from '../utils/sessionManager';
import { getObject, getObjectStrict, putObject, deleteObject, listObjects } from './cacheService';
import { getUserStrict, saveUser } from './userService';
import { peopleWhere } from './peopleService';
import { sendEmail } from '../utils/email';
import { escapeHtml } from '../utils/lexicalEmail';

/**
 * Feedback from the tab on the right edge of every page: the person's message, a screenshot
 * and what the browser collected (network calls, console, errors with their stacks,
 * navigation). Stored, then emailed to every Admin.
 *
 * Who sees the tab: the person's own `feedbackEnabled` if set, else the global switch.
 */

const SETTINGS_KEY = 'settings/feedback';
const PREFIX = 'feedback/';
const SCREENSHOT_PREFIX = 'feedback_screenshots/';

export const MAX_MESSAGE = 5000;
export const MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024;
export const MAX_DIAGNOSTICS_BYTES = 3 * 1024 * 1024;
/** Sends per person per hour. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;

export class FeedbackError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function getFeedbackSettings(env: Env): Promise<FeedbackSettings> {
  const stored = await getObject<FeedbackSettings>(SETTINGS_KEY, env);
  return { enabled: stored?.enabled === true, updatedAt: stored?.updatedAt, updatedBy: stored?.updatedBy };
}

export async function setFeedbackSettings(enabled: boolean, actor: User, env: Env): Promise<FeedbackSettings> {
  const settings: FeedbackSettings = { enabled, updatedAt: new Date().toISOString(), updatedBy: actor.email };
  await putObject(SETTINGS_KEY, settings, env, { contentType: 'application/json' });
  return settings;
}

/** Whether this person sees the feedback tab: their own setting, else the global switch. */
export async function feedbackEnabledFor(user: Pick<User, 'feedbackEnabled'>, env: Env): Promise<boolean> {
  if (user.feedbackEnabled === true || user.feedbackEnabled === false) return user.feedbackEnabled;
  return (await getFeedbackSettings(env)).enabled;
}

/** Set one person's feedback tab: true, false, or null to follow the global switch. */
export async function setPersonFeedback(id: string, value: boolean | null, env: Env): Promise<User> {
  const user = await getUserStrict(id, env);
  if (!user) throw new FeedbackError(404, 'Person not found');
  user.feedbackEnabled = value;
  await saveUser(user, env);
  return user;
}

// Recent sends per person (lowercased email), for the rate limit. One task, so memory is enough.
const recentSends = new Map<string, number[]>();

function checkRate(email: string, now: number): void {
  const key = email.toLowerCase();
  const recent = (recentSends.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) throw new FeedbackError(429, 'That is a lot of feedback this hour. Please try again later.');
  recent.push(now);
  recentSends.set(key, recent);
}

/** For tests. */
export function resetFeedbackRateLimit(): void {
  recentSends.clear();
}

/** The JPEG in a `data:image/jpeg;base64,` URL, or null when there is none. */
export function decodeScreenshot(dataUrl: unknown): Uint8Array | null {
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') return null;
  const match = typeof dataUrl === 'string' ? dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/) : null;
  if (!match) throw new FeedbackError(400, 'The screenshot must be a JPEG data URL');
  const bytes = new Uint8Array(Buffer.from(match[1], 'base64'));
  if (bytes.length > MAX_SCREENSHOT_BYTES) throw new FeedbackError(413, 'The screenshot is too large');
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new FeedbackError(400, 'The screenshot is not a JPEG');
  }
  return bytes;
}

export interface FeedbackInput {
  message?: unknown;
  url?: unknown;
  screenshot?: unknown;
  diagnostics?: unknown;
}

export async function createFeedback(
  input: FeedbackInput,
  user: Pick<User, 'id' | 'email' | 'name' | 'feedbackEnabled'>,
  env: Env,
  clientIp?: string,
): Promise<FeedbackReport> {
  if (!(await feedbackEnabledFor(user, env))) throw new FeedbackError(403, 'Feedback is turned off');
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) throw new FeedbackError(400, 'Say what happened');
  if (message.length > MAX_MESSAGE) throw new FeedbackError(400, `Keep it under ${MAX_MESSAGE} characters`);
  const diagnostics = input.diagnostics && typeof input.diagnostics === 'object' && !Array.isArray(input.diagnostics)
    ? input.diagnostics as Record<string, any>
    : {};
  if (JSON.stringify(diagnostics).length > MAX_DIAGNOSTICS_BYTES) throw new FeedbackError(413, 'The diagnostics are too large');
  const screenshot = decodeScreenshot(input.screenshot);
  checkRate(user.email, Date.now());

  const report: FeedbackReport = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    user: { id: user.id, email: user.email, name: user.name || user.email },
    message,
    url: typeof input.url === 'string' ? input.url.slice(0, 2000) : '',
    hasScreenshot: !!screenshot,
    diagnostics,
    ...(clientIp ? { clientIp } : {}),
    handled: false,
    emailedTo: [],
  };
  if (screenshot) {
    await env.STORE.put(`${SCREENSHOT_PREFIX}${report.id}.jpg`, screenshot, { contentType: 'image/jpeg' });
  }
  await putObject(`${PREFIX}${report.id}`, report, env, { contentType: 'application/json' });

  // Stored first, so an email failure loses nothing; it never fails the send
  try {
    const admins = (await peopleWhere(env, (a) => a.isAdmin)).map((p) => p.email);
    if (admins.length === 0) {
      report.emailError = 'No Admins to email';
    } else {
      await emailAdmins(report, screenshot, admins, env);
      report.emailedTo = admins;
    }
  } catch (err) {
    console.error('Feedback email failed:', err);
    report.emailError = err instanceof Error ? err.message : String(err);
  }
  await putObject(`${PREFIX}${report.id}`, report, env, { contentType: 'application/json' });
  return report;
}

const EMAIL_ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));

/** The admin page for one report. */
export function feedbackLink(report: Pick<FeedbackReport, 'id'>, env: Env): string {
  return `${(env.FRONTEND_URL || '').replace(/\/$/, '')}/admin?tab=feedback&id=${encodeURIComponent(report.id)}`;
}

/** The email's summary (HTML, everything the person typed escaped); the full diagnostics are attached. */
export function feedbackEmailHtml(report: FeedbackReport, env: Env, withScreenshot: boolean): string {
  const d = report.diagnostics || {};
  const environment = d.environment || {};
  const viewport = environment.viewport || {};
  const failed = list(d.network).filter((n) => n && (n.error || (typeof n.status === 'number' && n.status >= 400))).slice(-10);
  const errors = list(d.errors).slice(-5);
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 12px 2px 0;color:#666;vertical-align:top">${escapeHtml(label)}</td><td style="padding:2px 0">${escapeHtml(value)}</td></tr>`;
  const parts = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:760px">`,
    `<h2 style="margin:0 0 8px">Feedback from ${escapeHtml(report.user.name)}</h2>`,
    `<div style="white-space:pre-wrap;border-left:3px solid #2f6f6f;padding:6px 12px;margin:0 0 12px;background:#f6f8f8">${escapeHtml(report.message)}</div>`,
    `<table style="border-collapse:collapse;font-size:13px">`,
    row('From', `${report.user.name} <${report.user.email}>`),
    row('When', report.createdAt),
    row('Page', report.url),
    row('Browser', str(environment.userAgent)),
    row('Window', viewport.width ? `${viewport.width}×${viewport.height} @${viewport.devicePixelRatio || 1}x` : ''),
    row('Build', str(d.app?.build)),
    row('Collected', `${list(d.network).length} network calls, ${list(d.console).length} console messages, ${list(d.errors).length} errors, ${list(d.breadcrumbs).length} steps`),
    `</table>`,
  ];
  if (failed.length > 0) {
    parts.push(`<h3 style="margin:16px 0 4px">Failed requests</h3><ul style="margin:0;padding-left:20px;font-size:13px">`);
    for (const n of failed) {
      parts.push(`<li><code>${escapeHtml(`${str(n.method)} ${str(n.url)}`)}</code> → ${escapeHtml(n.error ? str(n.error) : str(n.status))}</li>`);
    }
    parts.push('</ul>');
  }
  if (errors.length > 0) {
    parts.push(`<h3 style="margin:16px 0 4px">Errors</h3>`);
    for (const e of errors) {
      const stack = str(e.stack).split('\n').slice(0, 6).join('\n');
      parts.push(`<div style="font-size:13px;margin:0 0 8px"><strong>${escapeHtml(str(e.message))}</strong>${stack ? `<pre style="margin:2px 0 0;font-size:11px;white-space:pre-wrap;color:#555">${escapeHtml(stack)}</pre>` : ''}</div>`);
    }
  }
  if (withScreenshot) {
    parts.push(`<h3 style="margin:16px 0 4px">Screenshot</h3><img src="cid:screenshot" alt="Screenshot" style="max-width:100%;border:1px solid #ccc">`);
  }
  if (env.FRONTEND_URL) {
    parts.push(`<p style="margin:16px 0 0"><a href="${escapeHtml(feedbackLink(report, env))}">Open it in Scribe</a> (Admin → Feedback). The full diagnostics are attached.</p>`);
  }
  parts.push('</div>');
  return parts.join('\n');
}

async function emailAdmins(report: FeedbackReport, screenshot: Uint8Array | null, admins: string[], env: Env): Promise<void> {
  const firstLine = report.message.split('\n')[0];
  const subject = `[Scribe feedback] ${report.user.name}: ${firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine}`;
  const text = [
    `Feedback from ${report.user.name} <${report.user.email}>`,
    '',
    report.message,
    '',
    `Page: ${report.url}`,
    `When: ${report.createdAt}`,
    ...(env.FRONTEND_URL ? [`Open it in Scribe: ${feedbackLink(report, env)}`] : []),
    'The screenshot and full diagnostics are attached.',
  ].join('\n');
  const diagnostics = new TextEncoder().encode(JSON.stringify({ ...report, clientIp: undefined }, null, 2));
  await sendEmail(admins, subject, report.message, env, {
    ...(EMAIL_ADDRESS.test(report.user.email) ? { replyTo: report.user.email } : {}),
    html: feedbackEmailHtml(report, env, !!screenshot),
    text,
    attachments: [
      ...(screenshot ? [{ fileName: 'screenshot.jpg', contentType: 'image/jpeg', content: screenshot, contentId: 'screenshot' }] : []),
      { fileName: `feedback-${report.id}.json`, contentType: 'application/json', content: diagnostics },
    ],
  });
}

/** Every report, newest first, without the diagnostics (the list on Admin → Feedback). */
export async function listFeedback(env: Env) {
  const listing = await listObjects(PREFIX, env);
  const reports = await Promise.all(
    (listing?.objects || []).map((o: { key: string }) => getObject<FeedbackReport>(o.key, env)),
  );
  return (reports.filter(Boolean) as FeedbackReport[])
    .map(({ diagnostics, ...rest }) => ({
      ...rest,
      counts: {
        network: list(diagnostics?.network).length,
        failed: list(diagnostics?.network).filter((n) => n && (n.error || n.status >= 400)).length,
        errors: list(diagnostics?.errors).length,
      },
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getFeedback(id: string, env: Env): Promise<FeedbackReport | null> {
  return getObject<FeedbackReport>(`${PREFIX}${id}`, env);
}

export async function getFeedbackScreenshot(id: string, env: Env): Promise<ArrayBuffer | null> {
  const object = await env.STORE.get(`${SCREENSHOT_PREFIX}${id}.jpg`);
  return object ? object.arrayBuffer() : null;
}

/** Mark a report handled (or not) and keep notes on it. */
export async function updateFeedback(
  id: string,
  patch: { handled?: unknown; notes?: unknown },
  actor: User,
  env: Env,
): Promise<FeedbackReport> {
  const report = await getObjectStrict<FeedbackReport>(`${PREFIX}${id}`, env);
  if (!report) throw new FeedbackError(404, 'Feedback not found');
  if (patch.handled !== undefined) {
    if (typeof patch.handled !== 'boolean') throw new FeedbackError(400, 'handled must be true or false');
    report.handled = patch.handled;
    report.handledBy = patch.handled ? actor.email : undefined;
    report.handledAt = patch.handled ? new Date().toISOString() : undefined;
  }
  if (patch.notes !== undefined) {
    if (typeof patch.notes !== 'string') throw new FeedbackError(400, 'notes must be text');
    report.notes = patch.notes.slice(0, MAX_MESSAGE);
  }
  await putObject(`${PREFIX}${id}`, report, env, { contentType: 'application/json' });
  return report;
}

export async function deleteFeedback(id: string, env: Env): Promise<void> {
  await env.STORE.delete(`${SCREENSHOT_PREFIX}${id}.jpg`);
  await deleteObject(`${PREFIX}${id}`, env);
}
