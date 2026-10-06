import { AnnualDate, AnnualDateRule } from '../types';
import { addDays, daysBetween, weekday, ymd } from './ymd';

/**
 * Annual dates: when something that happens every year falls in a given year. A rule is the
 * same calendar date, or a number of days from Labor Day (the first Monday of September; the
 * Man burns the Saturday before). The year of an occurrence is its calendar year, not the
 * Comms Calendar's Sep→Aug cycle. Mirrored in frontend/src/utils/annualDates.ts.
 */

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
