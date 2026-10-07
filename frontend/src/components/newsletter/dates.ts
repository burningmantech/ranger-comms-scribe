/** Calendar dates in the newsletter's house style (the backend's formatCalendarDate). */

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

function parts(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

/** "July 12th"; "August 30 – September 7"; "July 12–14". The year only when not asOf's. */
export function formatCalendarDate(date: string, endDate: string | undefined, asOf: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const start = parts(date);
  const thisYear = parts(asOf).year;
  const withYear = (text: string, year: number) => (year !== thisYear ? `${text}, ${year}` : text);
  if (!endDate || endDate === date) return withYear(`${MONTHS[start.month - 1]} ${ordinal(start.day)}`, start.year);
  const end = parts(endDate);
  if (start.year === end.year && start.month === end.month) {
    return withYear(`${MONTHS[start.month - 1]} ${start.day}–${end.day}`, end.year);
  }
  const startText = start.year !== end.year
    ? withYear(`${MONTHS[start.month - 1]} ${start.day}`, start.year)
    : `${MONTHS[start.month - 1]} ${start.day}`;
  return `${startText} – ${withYear(`${MONTHS[end.month - 1]} ${end.day}`, end.year)}`;
}

/** Today (YYYY-MM-DD) in the user's time zone. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
