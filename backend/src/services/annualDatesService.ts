import { AnnualDate, AnnualDateOverride, AnnualDateRule, DateLink, User } from '../types';
import { Env } from '../utils/sessionManager';
import { getObject, putObject, deleteObject, listObjects } from './cacheService';
import { canEditCalendar } from './commsCalendarService';
import { isValidYmd } from '../utils/ymd';

/**
 * Annual dates: things that happen every year (a fixed date, or days from Labor Day), one object
 * per entry at annual_dates/<id>. Anyone signed in adds one when they track a date in their
 * request; the people who run the Comms Calendar change and delete them, and whoever added one
 * may change it.
 */

export const ANNUAL_DATES_PREFIX = 'annual_dates/';

export async function listAnnualDates(env: Env): Promise<AnnualDate[]> {
  const listing = await listObjects(ANNUAL_DATES_PREFIX, env);
  if (!listing?.objects) return [];
  const entries: AnnualDate[] = [];
  for (const obj of listing.objects) {
    const entry = await getObject<AnnualDate>(obj.key, env);
    if (entry) entries.push(entry);
  }
  return entries;
}

export async function getAnnualDate(id: string, env: Env): Promise<AnnualDate | null> {
  return getObject<AnnualDate>(`${ANNUAL_DATES_PREFIX}${id}`, env);
}

export async function saveAnnualDate(entry: AnnualDate, env: Env): Promise<void> {
  await putObject(`${ANNUAL_DATES_PREFIX}${entry.id}`, entry, env);
}

export async function deleteAnnualDate(id: string, env: Env): Promise<void> {
  await deleteObject(`${ANNUAL_DATES_PREFIX}${id}`, env);
}

/** Comms Calendar editors change every entry; others only the ones they added. (Delete is editors only.) */
export async function canEditAnnualDate(user: User, entry: AnnualDate | null, env: Env): Promise<boolean> {
  if (await canEditCalendar(user, env)) return true;
  return !!entry && !!user.email && entry.createdBy.toLowerCase() === user.email.toLowerCase();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LIMITS = { name: 200, notes: 2000, link: 2000, id: 200, text: 200, durationDays: 60, offsetDays: 180, overrides: 30 };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type AnnualDatePatch = {
  name?: string;
  rule?: AnnualDateRule;
  durationDays?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  overrides?: Record<string, AnnualDateOverride> | null;
  notes?: string | null;
  link?: string | null;
  createdFrom?: { submissionId: string; text: string };
};

class Invalid extends Error {}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new Invalid(`${field} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Invalid(`${field} is too long (max ${max} characters)`);
  return trimmed || null;
}

function time(value: unknown, field: string): string | null {
  if (value === null || value === '' || value === undefined) return null;
  if (typeof value !== 'string' || !HHMM.test(value)) throw new Invalid(`${field} must be a time (HH:mm)`);
  return value;
}

export function cleanRule(input: unknown): AnnualDateRule {
  const rule = input as Record<string, unknown> | null;
  if (!rule || typeof rule !== 'object') throw new Invalid('rule is required');
  if (rule.kind === 'fixed') {
    const month = rule.month;
    const day = rule.day;
    if (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12) throw new Invalid('rule.month must be 1–12');
    const lastDay = new Date(Date.UTC(2024, month as number, 0)).getUTCDate(); // a leap year, so Feb 29 is allowed
    if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > lastDay) throw new Invalid('rule.day is not a day of that month');
    return { kind: 'fixed', month: month as number, day: day as number };
  }
  if (rule.kind === 'laborDay') {
    const offset = rule.offsetDays;
    if (!Number.isInteger(offset) || Math.abs(offset as number) > LIMITS.offsetDays) {
      throw new Invalid(`rule.offsetDays must be a whole number of days within ${LIMITS.offsetDays} of Labor Day`);
    }
    return { kind: 'laborDay', offsetDays: offset as number };
  }
  throw new Invalid("rule.kind must be 'fixed' or 'laborDay'");
}

function cleanOverrides(input: unknown): Record<string, AnnualDateOverride> | null {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Invalid('overrides must be an object keyed by year');
  const entries = Object.entries(input as Record<string, any>);
  if (entries.length > LIMITS.overrides) throw new Invalid(`At most ${LIMITS.overrides} overrides`);
  const out: Record<string, AnnualDateOverride> = {};
  for (const [year, value] of entries) {
    if (!/^\d{4}$/.test(year)) throw new Invalid(`Override year ${year} is not a year`);
    if (!value || typeof value !== 'object') throw new Invalid(`Override for ${year} is invalid`);
    if (!isValidYmd(value.date)) throw new Invalid(`Override for ${year}: date must be YYYY-MM-DD`);
    const override: AnnualDateOverride = { date: value.date };
    if (value.endDate !== undefined && value.endDate !== null && value.endDate !== '') {
      if (!isValidYmd(value.endDate)) throw new Invalid(`Override for ${year}: end date must be YYYY-MM-DD`);
      if (value.endDate < value.date) throw new Invalid(`Override for ${year}: the end date is before the start`);
      if (value.endDate !== value.date) override.endDate = value.endDate;
    }
    const startTime = time(value.startTime, `Override for ${year} start time`);
    const endTime = time(value.endTime, `Override for ${year} end time`);
    if (startTime) override.startTime = startTime;
    if (endTime) override.endTime = endTime;
    const note = optionalText(value.note ?? null, `Override for ${year} note`, LIMITS.text);
    if (note) override.note = note;
    out[year] = override;
  }
  return Object.keys(out).length ? out : null;
}

/** Check a create (`partial` false: name and rule required) or update body. */
export function validateAnnualDateInput(
  input: unknown,
  { partial }: { partial: boolean },
): { patch: AnnualDatePatch; error?: undefined } | { patch?: undefined; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected a JSON object' };
  const body = input as Record<string, unknown>;
  const has = (key: string) => body[key] !== undefined;
  const patch: AnnualDatePatch = {};
  try {
    if (has('name') || !partial) {
      const name = optionalText(body.name ?? '', 'name', LIMITS.name);
      if (!name) throw new Invalid('Name is required');
      patch.name = name;
    }
    if (has('rule') || !partial) patch.rule = cleanRule(body.rule);
    if (has('durationDays')) {
      const days = body.durationDays;
      if (days === null || days === 0) patch.durationDays = null;
      else if (!Number.isInteger(days) || (days as number) < 0 || (days as number) > LIMITS.durationDays) {
        throw new Invalid(`durationDays must be 0–${LIMITS.durationDays}`);
      } else patch.durationDays = days as number;
    }
    if (has('startTime')) patch.startTime = time(body.startTime, 'startTime');
    if (has('endTime')) patch.endTime = time(body.endTime, 'endTime');
    if (has('overrides')) patch.overrides = cleanOverrides(body.overrides);
    if (has('notes')) patch.notes = optionalText(body.notes, 'notes', LIMITS.notes);
    if (has('link')) {
      const link = optionalText(body.link, 'link', LIMITS.link);
      if (link !== null && !/^https?:\/\//i.test(link)) throw new Invalid('link must be an http(s) URL');
      patch.link = link;
    }
    if (!partial && body.createdFrom && typeof body.createdFrom === 'object') {
      const from = body.createdFrom as Record<string, unknown>;
      const submissionId = optionalText(from.submissionId ?? '', 'createdFrom.submissionId', LIMITS.id);
      const text = optionalText(from.text ?? '', 'createdFrom.text', LIMITS.text);
      if (submissionId || text) patch.createdFrom = { submissionId: submissionId || '', text: text || '' };
    }
  } catch (error) {
    if (error instanceof Invalid) return { error: error.message };
    throw error;
  }
  return { patch };
}

/** Apply a validated patch: null removes the field. */
export function applyAnnualDatePatch(entry: AnnualDate, patch: AnnualDatePatch): AnnualDate {
  const next: Record<string, unknown> = { ...entry };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as unknown as AnnualDate;
}

export function newAnnualDate(patch: AnnualDatePatch, createdBy: string, id: string = crypto.randomUUID()): AnnualDate {
  const now = new Date().toISOString();
  const base: AnnualDate = {
    id,
    name: '',
    rule: { kind: 'fixed', month: 1, day: 1 },
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  return applyAnnualDatePatch(base, patch);
}

// ---------------------------------------------------------------------------
// A request's links to annual dates
// ---------------------------------------------------------------------------

const MAX_DATE_LINKS = 40;

/** Validate a request's dateLinks; throws Error with a message for a 400. */
export function cleanDateLinks(input: unknown): DateLink[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Invalid('dateLinks must be a list');
  if (input.length > MAX_DATE_LINKS) throw new Invalid(`At most ${MAX_DATE_LINKS} linked dates`);
  return input.map((raw: any, i) => {
    const field = `Linked date ${i + 1}`;
    if (!raw || typeof raw !== 'object') throw new Invalid(`${field} is invalid`);
    const id = optionalText(raw.id ?? '', `${field} id`, LIMITS.id);
    const annualDateId = optionalText(raw.annualDateId ?? '', `${field} annual date`, LIMITS.id);
    const text = optionalText(raw.text ?? '', `${field} text`, LIMITS.text);
    if (!id || !annualDateId || !text) throw new Invalid(`${field} needs an id, an annual date and its text`);
    if (raw.field !== 'body' && raw.field !== 'blurb') throw new Invalid(`${field}: field must be body or blurb`);
    if (!Number.isInteger(raw.year) || raw.year < 2000 || raw.year > 2100) throw new Invalid(`${field}: year must be a year`);
    return { id, annualDateId, field: raw.field, text, year: raw.year };
  });
}

export { Invalid as AnnualDateInputError };
