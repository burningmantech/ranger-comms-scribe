import { AnnualDate, AnnualDateRule } from '../types/annualDates';

/**
 * Annual dates: when something that happens every year falls in a given year. A rule is the
 * same calendar date, or a number of days from Labor Day (the first Monday of September; the
 * Man burns the Saturday before). The year of an occurrence is its calendar year, not the
 * Comms Calendar's Sep→Aug cycle. Mirrors backend/src/utils/annualDates.ts (and its tests).
 */

// Calendar dates as YYYY-MM-DD strings, arithmetic in UTC (backend/src/utils/ymd.ts)

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidYmd(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = YMD.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function toUtc(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDays(ymdValue: string, days: number): string {
  const date = toUtc(ymdValue);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

/** Days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(ymdValue: string): number {
  return toUtc(ymdValue).getUTCDay();
}

/** Burn night is always this many days from Labor Day. */
export const BURN_OFFSET = -2;

/** The first Monday of September. */
export function laborDay(year: number): string {
  const first = ymd(year, 9, 1);
  return addDays(first, (8 - weekday(first)) % 7);
}

/** The Saturday the Man burns. */
export function burnDay(year: number): string {
  return addDays(laborDay(year), BURN_OFFSET);
}

export interface Occurrence {
  year: number;
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  /** The year's date was moved by hand away from the rule. */
  overridden?: boolean;
}

/** The rule's date in `year` (Feb 29 is Feb 28 in other years). */
export function ruleDate(rule: AnnualDateRule, year: number): string {
  if (rule.kind === 'laborDay') return addDays(laborDay(year), rule.offsetDays);
  const lastDay = new Date(Date.UTC(year, rule.month, 0)).getUTCDate();
  return ymd(year, rule.month, Math.min(rule.day, lastDay));
}

type Resolvable = Pick<AnnualDate, 'rule' | 'durationDays' | 'startTime' | 'endTime' | 'overrides'>;

/** When the entry happens in `year`: that year's override, else the rule. */
export function resolveAnnualDate(entry: Resolvable, year: number): Occurrence {
  const override = entry.overrides?.[String(year)];
  if (override) {
    const out: Occurrence = { year, date: override.date, overridden: true };
    if (override.endDate && override.endDate !== override.date) out.endDate = override.endDate;
    const startTime = override.startTime ?? entry.startTime;
    const endTime = override.endTime ?? entry.endTime;
    if (startTime) out.startTime = startTime;
    if (endTime) out.endTime = endTime;
    return out;
  }
  const date = ruleDate(entry.rule, year);
  const out: Occurrence = { year, date };
  if (entry.durationDays) out.endDate = addDays(date, entry.durationDays);
  if (entry.startTime) out.startTime = entry.startTime;
  if (entry.endTime) out.endTime = entry.endTime;
  return out;
}

/** The first occurrence that hasn't ended by `fromYmd`. */
export function nextOccurrence(entry: Resolvable, fromYmd: string): Occurrence {
  const year = Number(fromYmd.slice(0, 4));
  for (let y = year - 1; y <= year + 2; y++) {
    const occurrence = resolveAnnualDate(entry, y);
    if ((occurrence.endDate || occurrence.date) >= fromYmd) return occurrence;
  }
  return resolveAnnualDate(entry, year + 1);
}

/** The occurrence that falls on `dateYmd`, if any (checks the neighbouring years for large offsets). */
export function occurrenceOn(entry: Resolvable, dateYmd: string): Occurrence | null {
  const year = Number(dateYmd.slice(0, 4));
  for (const y of [year, year - 1, year + 1]) {
    const occurrence = resolveAnnualDate(entry, y);
    if (occurrence.date === dateYmd) return occurrence;
  }
  return null;
}

/** A rule that puts `dateYmd` where it is: the same calendar date, or its distance from that year's Labor Day. */
export function ruleFromDate(dateYmd: string, kind: AnnualDateRule['kind']): AnnualDateRule {
  const [y, m, d] = dateYmd.split('-').map(Number);
  if (kind === 'fixed') return { kind: 'fixed', month: m, day: d };
  return { kind: 'laborDay', offsetDays: daysBetween(laborDay(y), dateYmd) };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];

/** "6 days", "2 weeks", "1 week and 3 days" */
export function describeDays(days: number): string {
  const n = Math.abs(days);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (n >= 7) {
    const weeks = Math.floor(n / 7);
    const rest = n % 7;
    return rest ? `${plural(weeks, 'week')} and ${plural(rest, 'day')}` : plural(weeks, 'week');
  }
  return plural(n, 'day');
}

function relativeTo(offset: number, anchor: string): string {
  if (offset === 0) return anchor;
  return `${describeDays(offset)} ${offset < 0 ? 'before' : 'after'} ${anchor}`;
}

/** "Every September 1", "6 days before Labor Day (4 days before the Burn)" */
export function describeRule(rule: AnnualDateRule): string {
  if (rule.kind === 'fixed') return `Every ${MONTHS[rule.month - 1]} ${rule.day}`;
  const fromLaborDay = relativeTo(rule.offsetDays, 'Labor Day');
  const fromBurn = rule.offsetDays - BURN_OFFSET;
  if (rule.offsetDays === BURN_OFFSET) return `The Burn (${fromLaborDay})`;
  return `${fromLaborDay} (${relativeTo(fromBurn, 'the Burn')})`;
}

// ---------------------------------------------------------------------------
// Display (frontend only)
// ---------------------------------------------------------------------------

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "6pm", "6:30pm", "noon" */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === 12 && m === 0) return 'noon';
  const hour = h % 12 || 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

/** "Tue Aug 31, 2027", "Sun Aug 30 – Mon Sep 7, 2026" */
export function formatYmd(ymdValue: string, withYear = true): string {
  const [y, m, d] = ymdValue.split('-').map(Number);
  const text = `${WEEKDAYS_SHORT[weekday(ymdValue)]} ${MONTHS[m - 1].slice(0, 3)} ${d}`;
  return withYear ? `${text}, ${y}` : text;
}

/** "6–10pm", "6pm", "" */
export function formatTimes(startTime?: string, endTime?: string): string {
  if (!startTime) return endTime ? `until ${formatTime(endTime)}` : '';
  if (!endTime) return formatTime(startTime);
  const start = formatTime(startTime);
  const end = formatTime(endTime);
  const sameHalf = start.slice(-2) === end.slice(-2) && /[ap]m$/.test(start);
  return `${sameHalf ? start.slice(0, -2) : start}–${end}`;
}

/** "Tue Aug 31, 2027, 6–10pm" */
export function formatOccurrence(occurrence: Pick<Occurrence, 'date' | 'endDate' | 'startTime' | 'endTime'>): string {
  const dates = occurrence.endDate
    ? `${formatYmd(occurrence.date, occurrence.date.slice(0, 4) !== occurrence.endDate.slice(0, 4))} – ${formatYmd(occurrence.endDate)}`
    : formatYmd(occurrence.date);
  const times = formatTimes(occurrence.startTime, occurrence.endTime);
  return times ? `${dates}, ${times}` : dates;
}
