import { CommsCalendarEntry } from '../types/commsCalendar';

// Dates are YYYY-MM-DD strings throughout the Comms Calendar. Comms works in Sep→Aug
// cycles (the year after a Burn), so "2025–26" holds Sep 2025 to Aug 2026.

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function cycleStartYear(ymd: string): number {
  const [y, m] = ymd.split('-').map(Number);
  return m >= 9 ? y : y - 1;
}

export function cycleLabel(startYear: number): string {
  return `${startYear}–${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** The date an entry sorts by: target, else sent, else when it was added. */
export function anchorDate(entry: Pick<CommsCalendarEntry, 'targetDate' | 'dateSent' | 'createdAt'>): string {
  return entry.targetDate || entry.dateSent || (entry.createdAt || '').slice(0, 10);
}

/** The cycle (start year) an entry belongs to: from its dates, else its cycleYear, else when it was added. */
export function entryCycle(entry: Pick<CommsCalendarEntry, 'targetDate' | 'dateSent' | 'createdAt' | 'cycleYear'>): number {
  const dated = entry.targetDate || entry.dateSent;
  if (dated) return cycleStartYear(dated);
  return entry.cycleYear ?? cycleStartYear((entry.createdAt || localToday()).slice(0, 10));
}

/** "Sep 14", or "Sep 14, 2025" with the year. */
export function formatShortDate(ymd: string | undefined, withYear = false): string {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return `${MONTHS_SHORT[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

/** "in 12 days", "today", "3 days ago" */
export function describeDaysUntil(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** The same month and day `years` later; Feb 29 becomes Feb 28 in a non-leap year. */
export function addYearsClamped(ymd: string, years: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = y + years;
  const lastDay = new Date(Date.UTC(target, m, 0)).getUTCDate();
  return `${target}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** Emails from a comma, semicolon or space separated string, lowercased, without repeats. */
export function splitEmails(value: string): string[] {
  const seen = new Set<string>();
  for (const part of value.split(/[,;\s]+/)) {
    const email = part.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return Array.from(seen);
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(value);
}
