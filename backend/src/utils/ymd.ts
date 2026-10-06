/** Calendar dates as YYYY-MM-DD strings, with the arithmetic done in UTC so no timezone shifts a day. */

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
