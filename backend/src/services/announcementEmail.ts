import { ContentSubmission } from '../types';
import { Env } from '../utils/sessionManager';
import { getObject } from './cacheService';
import { getTrackedChanges, freshProposedVersions, TrackedChange } from './trackedChangesService';
import { renderContentForEmail, parseLexical, escapeHtml, EMAIL_FONT_FAMILY } from '../utils/lexicalEmail';

/**
 * The announcement email for an approved submission. One builder for both
 * GET /content/submissions/:id/email-preview and POST /content/submissions/:id/send-email,
 * so the preview is exactly what is sent.
 */
export interface AnnouncementEmail {
  /** The approved Subject (the title, or the newest approved Subject change). */
  subject: string;
  /** ANNOUNCE_EMAIL_TO, or null when sending is not configured. */
  to: string | null;
  /** The approved Reply-To when it is a valid address, else null. */
  replyTo: string | null;
  /** The approved Reply-To value when it is not a valid address (left out of the email). */
  replyToInvalid?: string;
  /** The approved Audience (labels, comma separated). Not a recipient: `to` is. */
  audience: string;
  /** The approved signature text ('' if none). */
  signature: string;
  /** The complete HTML body sent to SES. */
  html: string;
  /** The complete plain-text body sent to SES. */
  text: string;
}

const time = (value: string | undefined): number => {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/**
 * The approved value of a form field (title, audience, replyToAddress, signatureText): the
 * whole value of the newest approved tracked change, else `fallback`. The review page sends
 * the whole value; createTrackedChange keeps it in completeProposedVersion and stores only
 * the changed words in newValue (batch-created changes keep it in newValue). Pending and
 * rejected changes are not approved.
 */
export function approvedFieldValue(changes: TrackedChange[], field: string, fallback: string): string {
  const wholeValue = (c: TrackedChange) =>
    typeof c.completeProposedVersion === 'string' ? c.completeProposedVersion : c.newValue;
  const approved = changes
    .filter((c) => c.field === field && c.status === 'approved' && typeof wholeValue(c) === 'string')
    .sort((a, b) => (time(b.timestamp) - time(a.timestamp)) || (time(b.approvedAt) - time(a.approvedAt)));
  return approved.length > 0 ? wholeValue(approved[0]) : fallback;
}

/** A form value as submitted, found by id and then by label (as the review page does). */
function formValue(submission: ContentSubmission, id: string, labelMatch: (label: string) => boolean): string {
  const fields = submission.formFields || [];
  const field = fields.find((f) => f.id === id) || fields.find((f) => labelMatch((f.label || '').toLowerCase()));
  if (!field) return '';
  return Array.isArray(field.value) ? field.value.join(', ') : String(field.value ?? '');
}

const EMAIL_ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** A Reply-To SES accepts: a bare address, or `Name <address>`. Null if invalid. */
export function validReplyTo(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  if (EMAIL_ADDRESS.test(trimmed)) return trimmed;
  const named = /^([^<>"]*)<([^<>]+)>$/.exec(trimmed);
  if (named && EMAIL_ADDRESS.test(named[2].trim())) {
    const name = named[1].trim();
    return name ? `${name} <${named[2].trim()}>` : named[2].trim();
  }
  return null;
}

/**
 * The approved document: what the review page's Proposed view shows. That is the stored
 * proposed document (proposed_versions/<id>) unless a change is newer than it, then
 * richTextContent, then content. Accepting or rejecting writes the same document to both.
 * Never originalContent (the as-submitted snapshot).
 */
export async function approvedDocument(submission: ContentSubmission, changes: TrackedChange[], env: Env): Promise<string> {
  const saved = freshProposedVersions(await getObject<any>(`proposed_versions/${submission.id}`, env), changes);
  const candidates = [saved?.proposedVersionsRichText, submission.richTextContent, submission.content];
  const lexical = candidates.find((c) => typeof c === 'string' && parseLexical(c));
  if (lexical) return lexical;
  return [submission.richTextContent, submission.content].find((c) => typeof c === 'string' && c.trim()) || '';
}

function renderSignatureHtml(signature: string): string {
  if (!signature.trim()) return '';
  const lines = escapeHtml(signature.replace(/\r\n?/g, '\n').trim()).replace(/\n/g, '<br>');
  return `<div style="margin:24px 0 0 0;padding:12px 0 0 0;border-top:1px solid #dddddd;color:#444444;">${lines}</div>`;
}

/**
 * The full HTML document. No "Comms Scribe" banner: the announcement goes to Rangers as
 * the request's own message (its Subject is the headline), not as an app notification.
 * A 600px content column, centred; inline styles only.
 */
export function wrapAnnouncementHtml(subject: string, bodyHtml: string, signature: string): string {
  return '<!DOCTYPE html>'
    + '<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeHtml(subject)}</title></head>`
    + '<body style="margin:0;padding:0;background-color:#ffffff;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;">'
    + '<tr><td align="center" style="padding:16px 8px;">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">'
    + `<tr><td style="font-family:${EMAIL_FONT_FAMILY};font-size:15px;line-height:1.5;color:#222222;text-align:left;word-wrap:break-word;">`
    + bodyHtml
    + renderSignatureHtml(signature)
    + '</td></tr></table>'
    + '</td></tr></table>'
    + '</body></html>';
}

export async function buildAnnouncementEmail(submission: ContentSubmission, env: Env): Promise<AnnouncementEmail> {
  const changes = await getTrackedChanges(submission.id, env);

  const subject = approvedFieldValue(changes, 'title', submission.title || '')
    .replace(/\s+/g, ' ')
    .trim();
  const replyToValue = approvedFieldValue(changes, 'replyToAddress',
    formValue(submission, 'replyToAddress', (l) => l.includes('reply'))).trim();
  const signature = approvedFieldValue(changes, 'signatureText',
    formValue(submission, 'signatureText', (l) => l.includes('signature')));
  const audience = approvedFieldValue(changes, 'audience',
    formValue(submission, 'audience', (l) => l === 'audience'));

  const document = await approvedDocument(submission, changes, env);
  const body = renderContentForEmail(document, { publicUrl: env.PUBLIC_URL });

  const replyTo = replyToValue ? validReplyTo(replyToValue) : null;
  const signatureText = signature.replace(/\r\n?/g, '\n').trim();
  const text = [body.text, signatureText].filter(Boolean).join('\n\n') + '\n';

  return {
    subject,
    to: env.ANNOUNCE_EMAIL_TO || null,
    replyTo,
    ...(replyToValue && !replyTo ? { replyToInvalid: replyToValue } : {}),
    audience,
    signature: signatureText,
    html: wrapAnnouncementHtml(subject, body.html, signatureText),
    text,
  };
}
