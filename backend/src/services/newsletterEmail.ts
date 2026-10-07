import { CalendarRow, KeyDate, NewsletterEdition, NewsletterPhoto, NewsletterSection } from '../types';
import { renderContentForEmail, escapeHtml, safeUrl, EMAIL_FONT_FAMILY, EMAIL_MAX_IMAGE_WIDTH } from '../utils/lexicalEmail';

/**
 * The newsletter edition as an email: one builder for the editor's preview, the test send,
 * the send to Announce and the public web page, so all four are the same.
 *
 * Inline styles and tables only (mail apps drop <style> and most layout CSS). Every value
 * is escaped and every URL goes through safeUrl. Lexical bodies use the announcement
 * renderer (utils/lexicalEmail.ts).
 */

export const DEFAULT_EDITION_TITLE = 'Black Rock Ranger News';
export const DEFAULT_EDITION_TAGLINE = 'All the Dust that Fits Under Your Hat';
export const SUBJECT_SERIES = 'Ranger News';
/** Around parts that only make sense in the email (stripped by webCopy). */
const EMAIL_ONLY_START = '<!--email-only-->';
const EMAIL_ONLY_END = '<!--/email-only-->';

/** The sent HTML for the web page: without the email-only parts. */
export function webCopy(html: string): string {
  return html.replace(/<!--email-only-->[\s\S]*?<!--\/email-only-->/g, '');
}

/** Gmail cuts messages off ("[Message clipped]") a little past 100 KB of HTML. */
export const GMAIL_CLIP_WARNING_BYTES = 95 * 1024;

const COLORS = {
  page: '#f4efe6',
  card: '#ffffff',
  masthead: '#7a4100',
  heading: '#7d5c00',
  text: '#222222',
  muted: '#6b6b6b',
  rule: '#222222',
  sand: '#fbe5cc',
  sandBorder: '#e8c9a3',
  importantBar: '#b8860b',
  importantPanel: '#fdf1e1',
  button: '#7a4100',
  link: '#1a5fb4',
};

const CONTENT_PADDING = 24;
const CONTENT_WIDTH = 600 - CONTENT_PADDING * 2;
const LINK_SCHEMES = ['http:', 'https:', 'mailto:'];
const IMAGE_SCHEMES = ['http:', 'https:'];

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarEntry extends KeyDate {
  /** Stable key for hiding a derived row: date|endDate|label. */
  key: string;
  /** Where the row comes from: a section's key dates, or added by hand. */
  source: 'section' | 'manual';
  sectionId?: string;
  rowId?: string;
}

export function calendarRowKey(row: KeyDate): string {
  return `${row.date}|${row.endDate || ''}|${row.label.trim().toLowerCase()}`;
}

/**
 * The calendar as it will be sent: the sections' key dates (less the ones hidden) and the
 * manual rows, de-duplicated (a manual row wins), sorted by date, without rows that have
 * ended before `asOf` (YYYY-MM-DD). Pass includePast to keep those (the editor shows them).
 */
export function calendarEntries(
  edition: Pick<NewsletterEdition, 'sections' | 'calendar' | 'calendarHidden'>,
  asOf: string,
  options: { includePast?: boolean; includeHidden?: boolean } = {},
): CalendarEntry[] {
  const hidden = new Set(edition.calendarHidden || []);
  const byKey = new Map<string, CalendarEntry>();
  for (const row of edition.calendar || []) {
    const key = calendarRowKey(row);
    if (!byKey.has(key)) byKey.set(key, { ...stripId(row), key, source: 'manual', rowId: row.id });
  }
  for (const section of edition.sections || []) {
    for (const date of section.keyDates || []) {
      const key = calendarRowKey(date);
      const existing = byKey.get(key);
      if (existing) {
        // The same date twice: one row, which keeps a link if either has one
        if (!existing.link && date.link) {
          existing.link = date.link;
          if (date.linkLabel) existing.linkLabel = date.linkLabel;
        }
        continue;
      }
      if (hidden.has(key) && !options.includeHidden) continue;
      byKey.set(key, { ...date, key, source: 'section', sectionId: section.id });
    }
  }
  return Array.from(byKey.values())
    .filter((row) => options.includePast || (row.endDate || row.date) >= asOf)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.endDate || a.date).localeCompare(b.endDate || b.date)
      || a.label.localeCompare(b.label));
}

function stripId(row: CalendarRow): KeyDate {
  const { id: _id, ...rest } = row;
  return rest;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

function parts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

/**
 * House style: "July 12th"; a range "August 30 – September 7" or "July 12–14". The year is
 * shown only when it isn't asOf's year.
 */
export function formatCalendarDate(date: string, endDate: string | undefined, asOf: string): string {
  const start = parts(date);
  const thisYear = parts(asOf).year;
  const withYear = (text: string, year: number) => (year !== thisYear ? `${text}, ${year}` : text);
  if (!endDate || endDate === date) {
    return withYear(`${MONTHS[start.month - 1]} ${ordinal(start.day)}`, start.year);
  }
  const end = parts(endDate);
  if (start.year === end.year && start.month === end.month) {
    return withYear(`${MONTHS[start.month - 1]} ${start.day}–${end.day}`, end.year);
  }
  const startText = start.year !== end.year
    ? withYear(`${MONTHS[start.month - 1]} ${start.day}`, start.year)
    : `${MONTHS[start.month - 1]} ${start.day}`;
  return `${startText} – ${withYear(`${MONTHS[end.month - 1]} ${end.day}`, end.year)}`;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface NewsletterEmailContext {
  /** PUBLIC_URL (https://scrivenly.com/api): makes gallery URLs absolute. */
  publicUrl?: string;
  /** Calendar rows that end before this date (YYYY-MM-DD) are left out. */
  asOf: string;
  /** The edition's public page, for "View in your browser" (omitted when null). */
  webUrl?: string | null;
  /** The public archive of past editions (omitted when null). */
  archiveUrl?: string | null;
  /** The public page of a submission's document, for "Read more" (null: not available). */
  documentUrl: (submissionId: string) => string | null;
}

export interface NewsletterEmail {
  subject: string;
  html: string;
  text: string;
  sizeBytes: number;
  warnings: string[];
}

export function editionSubject(edition: Pick<NewsletterEdition, 'subject' | 'number'>): string {
  const subject = (edition.subject || '').replace(/\s+/g, ' ').trim();
  const series = `${SUBJECT_SERIES} #${edition.number}`;
  return subject ? `${subject} - ${series}` : series;
}

/** Split a long masthead title onto two lines at the space nearest its middle. */
function mastheadLines(title: string): string[] {
  const words = title.trim().split(/\s+/);
  if (title.length <= 14 || words.length < 2) return [title.trim()];
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

const font = `font-family:${EMAIL_FONT_FAMILY};`;

function row(content: string, padding = `0 ${CONTENT_PADDING}px`): string {
  return `<tr><td style="padding:${padding};${font}font-size:16px;line-height:1.5;color:${COLORS.text};text-align:left;word-wrap:break-word;">${content}</td></tr>`;
}

function renderPhotoHtml(photo: NewsletterPhoto, publicUrl: string | undefined, width: number): string {
  const src = safeUrl(photo.mediumSrc, IMAGE_SCHEMES, publicUrl) || safeUrl(photo.src, IMAGE_SCHEMES, publicUrl);
  if (!src) return '';
  const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(photo.alt || '')}" width="${width}" style="display:block;border:0;outline:none;width:100%;max-width:${width}px;height:auto;">`;
  const credit = photo.credit
    ? `<div style="${font}font-size:13px;line-height:1.4;color:${COLORS.muted};text-align:right;padding:4px 0 0 0;">Photo: ${escapeHtml(photo.credit)}</div>`
    : '';
  const caption = photo.caption
    ? `<div style="${font}font-size:14px;line-height:1.4;color:${COLORS.text};padding:4px 0 0 0;">${escapeHtml(photo.caption)}</div>`
    : '';
  return `<div style="margin:16px 0 0 0;">${img}${credit}${caption}</div>`;
}

function renderButtonHtml(href: string, label: string): string {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0 0;"><tr>'
    + `<td style="background-color:${COLORS.button};border-radius:4px;">`
    + `<a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;${font}font-size:15px;font-weight:bold;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:4px;">${escapeHtml(label)} &rarr;</a>`
    + '</td></tr></table>';
}

interface SectionRender {
  html: string;
  text: string;
  warnings: string[];
}

function readMoreTarget(section: NewsletterSection, ctx: NewsletterEmailContext): { href: string | null; label: string; missing?: string } {
  const label = section.readMore.label || 'Read more';
  if (section.readMore.kind === 'url') {
    return { href: safeUrl(section.readMore.url, LINK_SCHEMES, ctx.publicUrl), label };
  }
  if (section.readMore.kind === 'document') {
    const id = section.readMore.submissionId;
    const href = id ? ctx.documentUrl(id) : null;
    return { href, label, ...(href ? {} : { missing: 'document' }) };
  }
  return { href: null, label };
}

function renderSection(section: NewsletterSection, ctx: NewsletterEmailContext): SectionRender {
  const warnings: string[] = [];
  const heading = section.heading.trim();
  const body = renderContentForEmail(section.body, { publicUrl: ctx.publicUrl });
  const innerWidth = section.important ? CONTENT_WIDTH - 40 : CONTENT_WIDTH;
  const photos = section.photos.map((p) => renderPhotoHtml(p, ctx.publicUrl, Math.min(innerWidth, EMAIL_MAX_IMAGE_WIDTH))).join('');

  const links = section.links
    .map((l) => ({ href: safeUrl(l.url, LINK_SCHEMES, ctx.publicUrl), label: l.label }))
    .filter((l): l is { href: string; label: string } => !!l.href);
  const linksHtml = links.length
    ? `<div style="margin:12px 0 0 0;">${links.map((l) =>
      `<div style="margin:0 0 4px 0;">&#8250;&nbsp;<a href="${escapeHtml(l.href)}" style="color:${COLORS.link};text-decoration:underline;">${escapeHtml(l.label)}</a></div>`).join('')}</div>`
    : '';

  const readMore = readMoreTarget(section, ctx);
  if (readMore.missing) warnings.push(`"${heading || 'Untitled section'}": its Read more document has no public page yet`);
  const buttonHtml = readMore.href ? renderButtonHtml(readMore.href, readMore.label) : '';

  if (!heading) warnings.push('A section has no heading');
  if (!body.text.trim() && section.photos.length === 0) warnings.push(`"${heading || 'Untitled section'}" has no text or photos`);

  const headingHtml = heading
    ? `<h2 style="margin:0 0 12px 0;${font}font-size:26px;line-height:1.25;font-weight:bold;color:${COLORS.heading};">${escapeHtml(heading)}</h2>`
    : '';
  const inner = `${headingHtml}<div>${body.html}</div>${photos}${linksHtml}${buttonHtml}`;
  const html = section.important
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>'
      + `<td width="6" style="width:6px;background-color:${COLORS.importantBar};font-size:0;line-height:0;">&nbsp;</td>`
      + `<td style="background-color:${COLORS.importantPanel};padding:16px 17px;${font}font-size:16px;line-height:1.5;color:${COLORS.text};">${inner}</td>`
      + '</tr></table>'
    : inner;

  const textParts = [heading.toUpperCase(), body.text.trim()];
  for (const p of section.photos) {
    const bits = [p.caption, p.credit ? `Photo: ${p.credit}` : ''].filter(Boolean).join(' — ');
    if (bits) textParts.push(`[${bits}]`);
  }
  for (const l of links) textParts.push(`${l.label}: ${l.href}`);
  if (readMore.href) textParts.push(`${readMore.label}: ${readMore.href}`);
  return { html, text: textParts.filter(Boolean).join('\n\n'), warnings };
}

function renderCalendarHtml(entries: CalendarEntry[], ctx: NewsletterEmailContext): string {
  const cell = `${font}font-size:15px;line-height:1.4;color:${COLORS.text};padding:12px;vertical-align:top;text-align:left;border-top:1px solid ${COLORS.sandBorder};`;
  const head = `${font}font-size:15px;line-height:1.4;font-weight:bold;color:${COLORS.text};padding:12px;text-align:left;`;
  const rows = entries.map((e) => {
    const href = e.link ? safeUrl(e.link, LINK_SCHEMES, ctx.publicUrl) : null;
    const more = href
      ? `<a href="${escapeHtml(href)}" style="color:${COLORS.link};text-decoration:underline;">${escapeHtml(e.linkLabel || 'Details')}</a>`
      : '&nbsp;';
    return `<tr><td style="${cell}width:32%;">${escapeHtml(formatCalendarDate(e.date, e.endDate, ctx.asOf))}</td>`
      + `<td style="${cell}">${escapeHtml(e.label)}</td><td style="${cell}width:30%;">${more}</td></tr>`;
  }).join('');
  return `<h2 style="margin:0 0 16px 0;${font}font-size:30px;line-height:1.2;font-weight:bold;color:${COLORS.heading};text-align:center;">Mark your calendar!</h2>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:4px solid ${COLORS.masthead};background-color:${COLORS.sand};">`
    + `<tr><td style="${head}">Date</td><td style="${head}">Event</td><td style="${head}">More information</td></tr>`
    + rows
    + '</table>';
}

function renderCalendarText(entries: CalendarEntry[], ctx: NewsletterEmailContext): string {
  const lines = entries.map((e) => {
    const href = e.link ? safeUrl(e.link, LINK_SCHEMES, ctx.publicUrl) : null;
    return `- ${formatCalendarDate(e.date, e.endDate, ctx.asOf)}: ${e.label}${href ? ` (${e.linkLabel ? `${e.linkLabel}: ` : ''}${href})` : ''}`;
  });
  return ['MARK YOUR CALENDAR!', ...lines].join('\n');
}

export function buildNewsletterEmail(edition: NewsletterEdition, ctx: NewsletterEmailContext): NewsletterEmail {
  const subject = editionSubject(edition);
  const title = (edition.title || DEFAULT_EDITION_TITLE).trim();
  const tagline = (edition.tagline || '').trim();
  const taglineText = [tagline, `#${edition.number}`].filter(Boolean).join(' • ');
  const warnings: string[] = [];

  const sections = edition.sections.map((s) => renderSection(s, ctx));
  sections.forEach((s) => warnings.push(...s.warnings));
  const calendar = calendarEntries(edition, ctx.asOf);
  const intro = renderContentForEmail(edition.intro || '', { publicUrl: ctx.publicUrl });
  const footnotes = renderContentForEmail(edition.footnotes || '', { publicUrl: ctx.publicUrl });

  const webUrl = ctx.webUrl ? safeUrl(ctx.webUrl, IMAGE_SCHEMES, ctx.publicUrl) : null;
  const archiveUrl = ctx.archiveUrl ? safeUrl(ctx.archiveUrl, IMAGE_SCHEMES, ctx.publicUrl) : null;
  const preheader = edition.sections.map((s) => s.heading.trim()).filter(Boolean).slice(0, 4).join(' · ');

  const rows: string[] = [];
  if (webUrl) {
    // Marked so the web copy can drop it (publicNews.ts): a page needn't link to itself
    rows.push(EMAIL_ONLY_START + row(`<div style="font-size:12px;line-height:1.4;color:${COLORS.muted};text-align:center;"><a href="${escapeHtml(webUrl)}" style="color:${COLORS.muted};text-decoration:underline;">View this edition in your browser</a></div>`, `12px ${CONTENT_PADDING}px 0 ${CONTENT_PADDING}px`) + EMAIL_ONLY_END);
  }
  rows.push(row(
    `<div style="${font}font-size:46px;line-height:1.05;font-weight:bold;color:${COLORS.masthead};text-align:center;">${mastheadLines(title).map(escapeHtml).join('<br>')}</div>`
    + `<div style="${font}font-size:18px;line-height:1.4;color:#333333;text-align:center;padding:14px 0 0 0;">${escapeHtml(taglineText)}</div>`
    + '<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:22px auto 0 auto;"><tr>'
    + `<td width="100" height="6" style="width:100px;height:6px;background-color:${COLORS.rule};font-size:0;line-height:0;">&nbsp;</td></tr></table>`,
    `28px ${CONTENT_PADDING}px 8px ${CONTENT_PADDING}px`,
  ));
  if (intro.html) rows.push(row(intro.html, `20px ${CONTENT_PADDING}px 0 ${CONTENT_PADDING}px`));
  if (edition.sections.length >= 4) {
    const items = edition.sections.map((s) => s.heading.trim()).filter(Boolean)
      .map((h) => `<li style="margin:0 0 2px 0;">${escapeHtml(h)}</li>`).join('');
    rows.push(row(
      `<div style="border-top:1px solid ${COLORS.sandBorder};border-bottom:1px solid ${COLORS.sandBorder};padding:12px 0;">`
      + `<div style="font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${COLORS.muted};">In this issue</div>`
      + `<ul style="margin:6px 0 0 0;padding-left:22px;font-size:15px;">${items}</ul></div>`,
      `20px ${CONTENT_PADDING}px 0 ${CONTENT_PADDING}px`,
    ));
  }
  for (const s of sections) rows.push(row(s.html, `28px ${CONTENT_PADDING}px 0 ${CONTENT_PADDING}px`));
  if (calendar.length > 0) rows.push(row(renderCalendarHtml(calendar, ctx), `36px ${CONTENT_PADDING}px 0 ${CONTENT_PADDING}px`));
  if (footnotes.html) {
    rows.push(row(`<div style="font-size:13px;line-height:1.5;color:${COLORS.muted};">${footnotes.html}</div>`, `28px ${CONTENT_PADDING}px 0 ${CONTENT_PADDING}px`));
  }
  const footerBits = [
    archiveUrl ? `<a href="${escapeHtml(archiveUrl)}" style="color:${COLORS.muted};text-decoration:underline;">Past editions</a>` : '',
    'Black Rock Rangers Communications',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  rows.push(row(`<div style="border-top:1px solid ${COLORS.sandBorder};padding:16px 0 0 0;font-size:12px;line-height:1.5;color:${COLORS.muted};text-align:center;">${footerBits}</div>`, `32px ${CONTENT_PADDING}px 24px ${CONTENT_PADDING}px`));

  const html = '<!DOCTYPE html>'
    + '<html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">'
    + `<title>${escapeHtml(subject)}</title></head>`
    + `<body style="margin:0;padding:0;background-color:${COLORS.page};">`
    + (preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COLORS.page};">${escapeHtml(preheader)}</div>` : '')
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.page};">`
    + '<tr><td align="center" style="padding:16px 8px;">'
    + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:${COLORS.card};">`
    + rows.join('')
    + '</table></td></tr></table></body></html>';

  const textParts = [
    title.toUpperCase(),
    taglineText,
    webUrl ? `View this edition in your browser: ${webUrl}` : '',
    intro.text.trim(),
    ...sections.map((s) => s.text),
    calendar.length ? renderCalendarText(calendar, ctx) : '',
    footnotes.text.trim(),
    archiveUrl ? `Past editions: ${archiveUrl}` : '',
  ].filter(Boolean);
  const text = textParts.join('\n\n') + '\n';

  if (edition.sections.length === 0) warnings.push('The edition has no sections');
  if (!(edition.subject || '').trim()) warnings.push('The edition has no subject');
  const sizeBytes = Buffer.byteLength(html, 'utf8');
  if (sizeBytes > GMAIL_CLIP_WARNING_BYTES) {
    warnings.push(`The email is ${Math.round(sizeBytes / 1024)} KB; Gmail clips messages over about 100 KB. Shorten it or move text to Read more pages.`);
  }
  return { subject, html, text, sizeBytes, warnings };
}
