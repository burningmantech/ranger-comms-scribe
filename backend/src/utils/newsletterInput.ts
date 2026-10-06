import {
  KeyDate,
  NewsletterLink,
  NewsletterPhoto,
  NewsletterReadMore,
  NewsletterRequest,
  NewsletterSection,
  CalendarRow,
  WritingHelp,
} from '../types';

/**
 * Validation for newsletter input from the request form, the review page and the edition
 * editor. Bad values throw InputError (a 400 with its message); text is trimmed and capped.
 * URLs are stored as given (gallery images stay relative) once their scheme is checked.
 */

export class InputError extends Error {}

export const MAX_REQUEST_PHOTOS = 2;
const MAX_SECTION_PHOTOS = 6;
const MAX_LINKS = 8;
const MAX_KEY_DATES = 20;
const MAX_SECTIONS = 40;
const MAX_CALENDAR_ROWS = 60;
const MAX_TEXT = 300;
/** Lexical JSON for a blurb or a section body (photos are references, so this is generous). */
const MAX_RICH_TEXT = 200_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new InputError(`${field} must be text`);
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length > max) throw new InputError(`${field} is too long (at most ${max} characters)`);
  return trimmed;
}

function richText(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new InputError(`${field} must be text`);
  if (value.length > MAX_RICH_TEXT) throw new InputError(`${field} is too long`);
  return value;
}

function list(value: unknown, field: string, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InputError(`${field} must be a list`);
  if (value.length > max) throw new InputError(`${field}: at most ${max}`);
  return value;
}

/** http(s) (and, for links, mailto) URLs; images may also be gallery paths (/api/gallery/...). */
export function checkUrl(value: unknown, field: string, kind: 'link' | 'image'): string {
  const raw = text(value, field, 2000);
  if (!raw) throw new InputError(`${field} is required`);
  if (kind === 'image' && raw.startsWith('/api/gallery/')) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError(`${field} must be a full web address (https://...)`);
  }
  const schemes = kind === 'link' ? ['http:', 'https:', 'mailto:'] : ['http:', 'https:'];
  if (!schemes.includes(url.protocol)) throw new InputError(`${field} must start with https://`);
  return raw;
}

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function cleanKeyDate(input: any, field = 'Date'): KeyDate {
  if (!input || typeof input !== 'object') throw new InputError(`${field} is invalid`);
  const date = text(input.date, `${field} date`, 10);
  if (!isRealDate(date)) throw new InputError(`${field}: the date must be YYYY-MM-DD`);
  const endDate = text(input.endDate, `${field} end date`, 10);
  if (endDate && !isRealDate(endDate)) throw new InputError(`${field}: the end date must be YYYY-MM-DD`);
  if (endDate && endDate < date) throw new InputError(`${field}: the end date is before the start date`);
  const label = text(input.label, `${field} description`, 200);
  if (!label) throw new InputError(`${field}: say what happens on that date`);
  const out: KeyDate = { date, label };
  if (endDate && endDate !== date) out.endDate = endDate;
  const link = text(input.link, `${field} link`, 2000);
  if (link) out.link = checkUrl(link, `${field} link`, 'link');
  const linkLabel = text(input.linkLabel, `${field} link text`, 120);
  if (linkLabel && out.link) out.linkLabel = linkLabel;
  return out;
}

export function cleanKeyDates(input: unknown): KeyDate[] {
  return list(input, 'Key dates', MAX_KEY_DATES).map((d, i) => cleanKeyDate(d, `Key date ${i + 1}`));
}

export function cleanPhoto(input: any, field = 'Photo'): NewsletterPhoto {
  if (!input || typeof input !== 'object') throw new InputError(`${field} is invalid`);
  const photo: NewsletterPhoto = {
    src: checkUrl(input.src, `${field} image`, 'image'),
    alt: text(input.alt, `${field} description`, 300),
  };
  if (input.mediumSrc) photo.mediumSrc = checkUrl(input.mediumSrc, `${field} image`, 'image');
  const credit = text(input.credit, `${field} credit`, 120);
  if (credit) photo.credit = credit;
  const caption = text(input.caption, `${field} caption`, 500);
  if (caption) photo.caption = caption;
  return photo;
}

export function cleanPhotos(input: unknown, max: number): NewsletterPhoto[] {
  return list(input, 'Photos', max).map((p, i) => cleanPhoto(p, `Photo ${i + 1}`));
}

export function cleanLinks(input: unknown): NewsletterLink[] {
  return list(input, 'Links', MAX_LINKS).map((l: any, i) => {
    const field = `Link ${i + 1}`;
    if (!l || typeof l !== 'object') throw new InputError(`${field} is invalid`);
    const url = checkUrl(l.url, field, 'link');
    return { label: text(l.label, `${field} text`, 200) || url, url };
  });
}

export function cleanReadMore(input: any, ownSubmissionId?: string): NewsletterReadMore {
  if (!input || typeof input !== 'object' || !input.kind || input.kind === 'none') return { kind: 'none' };
  const label = text(input.label, 'Read more text', 120);
  if (input.kind === 'url') {
    return { kind: 'url', url: checkUrl(input.url, 'Read more link', 'link'), ...(label ? { label } : {}) };
  }
  if (input.kind === 'document') {
    const submissionId = text(input.submissionId, 'Read more document', 100) || ownSubmissionId;
    return { kind: 'document', ...(submissionId ? { submissionId } : {}), ...(label ? { label } : {}) };
  }
  throw new InputError('Read more must be none, document or url');
}

export function cleanWritingHelp(input: any): WritingHelp {
  if (!input || typeof input !== 'object') return {};
  const out: WritingHelp = {};
  if (input.document === true) out.document = true;
  if (input.blurb === true) out.blurb = true;
  return out;
}

/** The newsletter item from the request form or the review page. */
export function cleanNewsletterRequest(input: any): NewsletterRequest {
  if (!input || typeof input !== 'object') throw new InputError('Newsletter item is invalid');
  const out: NewsletterRequest = {
    photos: cleanPhotos(input.photos, MAX_REQUEST_PHOTOS),
    links: cleanLinks(input.links),
    // A request's own document: the submission id is filled in when it's placed in an edition
    readMore: cleanReadMore(input.readMore),
  };
  if (out.readMore.kind === 'document') delete out.readMore.submissionId;
  const headline = text(input.headline, 'Headline', 200);
  if (headline) out.headline = headline;
  const blurb = richText(input.blurb, 'Blurb');
  if (blurb.trim()) out.blurb = blurb;
  return out;
}

/** A section from the edition editor. Source fields are not taken from the client. */
export function cleanSection(input: any, index: number): Omit<NewsletterSection, 'sourceSubmissionId' | 'sourceHash'> {
  const field = `Section ${index + 1}`;
  if (!input || typeof input !== 'object') throw new InputError(`${field} is invalid`);
  const id = text(input.id, `${field} id`, 100);
  if (!id) throw new InputError(`${field} has no id`);
  return {
    id,
    kind: input.kind === 'item' ? 'item' : 'custom',
    heading: text(input.heading, `${field} heading`, 200),
    ...(input.important === true ? { important: true } : {}),
    body: richText(input.body, `${field} text`),
    photos: cleanPhotos(input.photos, MAX_SECTION_PHOTOS),
    links: cleanLinks(input.links),
    readMore: cleanReadMore(input.readMore),
    keyDates: cleanKeyDates(input.keyDates),
  };
}

export function cleanSections(input: unknown) {
  const sections = list(input, 'Sections', MAX_SECTIONS).map((s, i) => cleanSection(s, i));
  const ids = new Set<string>();
  for (const s of sections) {
    if (ids.has(s.id)) throw new InputError('Two sections have the same id');
    ids.add(s.id);
  }
  return sections;
}

export function cleanCalendar(input: unknown): CalendarRow[] {
  return list(input, 'Calendar', MAX_CALENDAR_ROWS).map((row: any, i) => {
    const id = text(row?.id, `Calendar row ${i + 1} id`, 100);
    if (!id) throw new InputError(`Calendar row ${i + 1} has no id`);
    return { id, ...cleanKeyDate(row, `Calendar row ${i + 1}`) };
  });
}

export function cleanStringList(input: unknown, field: string, max = 200): string[] {
  return list(input, field, max).map((v) => text(v, field, 400)).filter(Boolean);
}

export { text as cleanText, richText as cleanRichText };
