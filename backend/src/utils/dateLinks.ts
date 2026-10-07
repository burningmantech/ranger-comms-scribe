import { DateLink } from '../types';

/** A request's or calendar entry's dates linked to annual dates; bad input throws DateLinkError (a 400). */

export class DateLinkError extends Error {}

const MAX_DATE_LINKS = 60;
const MAX_ID = 200;
const MAX_TEXT = 200;

function text(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new DateLinkError(`${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new DateLinkError(`${field} is too long (max ${max} characters)`);
  return trimmed;
}

export function cleanDateLinks(input: unknown): DateLink[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new DateLinkError('dateLinks must be a list');
  if (input.length > MAX_DATE_LINKS) throw new DateLinkError(`At most ${MAX_DATE_LINKS} linked dates`);
  return input.map((raw: any, i) => {
    const field = `Linked date ${i + 1}`;
    if (!raw || typeof raw !== 'object') throw new DateLinkError(`${field} is invalid`);
    const id = text(raw.id, `${field} id`, MAX_ID);
    const annualDateId = text(raw.annualDateId, `${field} annual date`, MAX_ID);
    const written = text(raw.text, `${field} text`, MAX_TEXT);
    if (!id || !annualDateId || !written) throw new DateLinkError(`${field} needs an id, an annual date and its text`);
    if (raw.field !== 'body' && raw.field !== 'blurb') throw new DateLinkError(`${field}: field must be body or blurb`);
    if (!Number.isInteger(raw.year) || raw.year < 2000 || raw.year > 2100) throw new DateLinkError(`${field}: year must be a year`);
    return { id, annualDateId, field: raw.field, text: written, year: raw.year };
  });
}
