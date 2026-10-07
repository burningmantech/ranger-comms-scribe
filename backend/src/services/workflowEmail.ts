import { ContentSubmission } from '../types';
import { Env } from '../utils/sessionManager';
import { commsRecipients, sendEmail } from '../utils/email';
import { escapeHtml } from '../utils/lexicalEmail';
import { AUDIENCE_LABELS, audienceKeys } from '../utils/audiences';
import { getUser } from './userService';

/**
 * The emails about a request's workflow (approval asks, updates for the submitter, reminder
 * digests): one simple layout, an HTML and a plain-text version with the same content.
 */

const DEFAULT_SITE = 'https://scrivenly.com';

function originOf(env: Pick<Env, 'FRONTEND_URL' | 'PUBLIC_URL'>): string {
  for (const candidate of [env.FRONTEND_URL, env.PUBLIC_URL]) {
    if (!candidate) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      // try the next
    }
  }
  return '';
}

/** The review page of a request, as an absolute link. */
export function requestLink(env: Pick<Env, 'FRONTEND_URL' | 'PUBLIC_URL'>, submissionId: string): string {
  return `${originOf(env)}/tracked-changes/${submissionId}`;
}

export interface WorkflowEmailDetail {
  label: string;
  value: string;
}

export interface WorkflowEmailItem {
  title: string;
  lines: string[];
  link: string;
}

export interface WorkflowEmail {
  heading: string;
  paragraphs: string[];
  details?: WorkflowEmailDetail[];
  /** A list of linked items, for digests. */
  items?: WorkflowEmailItem[];
  action?: { label: string; url: string };
  /** Defaults to "Comms Scribe · <the site>". */
  footer?: string;
  /** The site the default footer links to (default https://scrivenly.com). */
  siteUrl?: string;
}

export interface RenderedEmail {
  text: string;
  html: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Only web links go into href attributes
const safeUrl = (url: string): string => (/^https?:\/\//i.test(url) ? url : '');

function link(url: string, label: string, style = 'color:#1a56db;'): string {
  const href = safeUrl(url);
  return href ? `<a href="${escapeHtml(href)}" style="${style}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

export function renderWorkflowEmail(email: WorkflowEmail): RenderedEmail {
  const site = email.siteUrl || DEFAULT_SITE;
  const details = (email.details || []).filter((d) => d.value);
  const items = email.items || [];
  const footerText = email.footer ?? `Comms Scribe · ${site}`;

  const html: string[] = [];
  html.push(`<h1 style="margin:0 0 16px 0;font-size:20px;line-height:1.3;color:#111827;">${escapeHtml(email.heading)}</h1>`);
  for (const paragraph of email.paragraphs) {
    html.push(`<p style="margin:0 0 14px 0;">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`);
  }
  if (details.length > 0) {
    html.push('<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;border-collapse:collapse;font-size:14px;">');
    for (const d of details) {
      html.push(
        `<tr><td style="padding:3px 16px 3px 0;color:#6b7280;vertical-align:top;white-space:nowrap;">${escapeHtml(d.label)}</td>` +
        `<td style="padding:3px 0;color:#111827;vertical-align:top;">${escapeHtml(d.value)}</td></tr>`
      );
    }
    html.push('</table>');
  }
  if (items.length > 0) {
    html.push('<div style="margin:0 0 16px 0;">');
    for (const item of items) {
      html.push('<div style="padding:10px 0;border-top:1px solid #e5e7eb;">');
      html.push(`<div style="font-weight:600;">${link(item.link, item.title)}</div>`);
      for (const line of item.lines) {
        html.push(`<div style="font-size:14px;color:#6b7280;">${escapeHtml(line)}</div>`);
      }
      html.push('</div>');
    }
    html.push('</div>');
  }
  if (email.action && safeUrl(email.action.url)) {
    html.push(
      `<p style="margin:20px 0;"><a href="${escapeHtml(email.action.url)}" ` +
      'style="display:inline-block;padding:10px 20px;background:#1a56db;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">' +
      `${escapeHtml(email.action.label)}</a></p>`
    );
  }
  const footerHtml = email.footer !== undefined ? escapeHtml(email.footer) : `Comms Scribe &middot; ${link(site, site.replace(/^https?:\/\//, ''), 'color:#6b7280;')}`;

  const htmlBody =
    '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;">' +
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:#1f2933;">` +
    '<div style="background:#ffffff;border-radius:8px;padding:24px;">' +
    html.join('') +
    '</div>' +
    `<p style="margin:16px 0 0 0;font-size:12px;color:#6b7280;text-align:center;">${footerHtml}</p>` +
    '</div></body></html>';

  const text: string[] = [email.heading, ''];
  for (const paragraph of email.paragraphs) text.push(paragraph, '');
  if (details.length > 0) {
    for (const d of details) text.push(`${d.label}: ${d.value}`);
    text.push('');
  }
  for (const item of items) {
    text.push(item.title);
    for (const line of item.lines) text.push(`  ${line}`);
    if (item.link) text.push(`  ${item.link}`);
    text.push('');
  }
  if (email.action) text.push(`${email.action.label}: ${email.action.url}`, '');
  text.push('--', footerText);

  return { text: text.join('\n'), html: htmlBody };
}

/**
 * Send a rendered email. Always through commsRecipients(), so COMMS_EMAIL_OVERRIDE on dev and
 * staging sends it only to the override. Throws if the email can't be sent.
 */
export async function sendWorkflowEmail(
  env: Env,
  to: string[],
  subject: string,
  rendered: RenderedEmail,
  opts: { replyTo?: string } = {}
): Promise<void> {
  if (to.length === 0) return;
  const delivery = commsRecipients(to, subject, env);
  await sendEmail(delivery.to, delivery.subject, rendered.text, env, {
    html: rendered.html,
    text: rendered.text,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
  });
}

/** A date (YYYY-MM-DD) as "Fri, Oct 9"; anything else is shown as written. */
export function formatPublishBy(value: string): string {
  const ymd = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
  const date = ymd ? new Date(`${ymd}T12:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The details most useful in an email about a request: who sent it, when it must be out, to whom. */
export async function requestDetails(submission: ContentSubmission, env: Env): Promise<WorkflowEmailDetail[]> {
  const rows: WorkflowEmailDetail[] = [];

  let submitter = '';
  if (submission.submittedBy) {
    const user = await getUser(submission.submittedBy, env).catch(() => null);
    submitter = user?.name || user?.email || (submission.submittedBy.includes('@') ? submission.submittedBy : '');
  }
  rows.push({ label: 'Submitted by', value: submitter });

  const publishBy = (submission.formFields || []).find((f) => f.id === 'publishBy')?.value;
  rows.push({ label: 'Publish by', value: typeof publishBy === 'string' && publishBy.trim() ? formatPublishBy(publishBy.trim()) : '' });

  const audiences = audienceKeys(submission).map((key) => AUDIENCE_LABELS[key] || key);
  rows.push({ label: 'Audience', value: audiences.join(', ') });

  return rows.filter((row) => row.value);
}
