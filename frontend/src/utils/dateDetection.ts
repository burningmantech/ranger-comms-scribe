import * as chrono from 'chrono-node';
import { addDays, daysBetween, Occurrence } from './annualDates';

/**
 * Dates written in request text ("8/16/2023", "6pm - 10pm on Sept. 1 2026", "Aug 26 - Sept 1, 2026"),
 * found with chrono's strict parser and kept only when a month name or a numeric date is written, so
 * "today", "Friday", "next week" or "one minute after" don't count. A date without a year takes the
 * year chrono picks near the reference date.
 */

export interface DetectedDate {
  /** The whole match, times included ("6pm - 10pm on Sept. 1 2026"). */
  text: string;
  index: number;
  date: string;
  endDate?: string;
  /** "HH:mm" */
  startTime?: string;
  endTime?: string;
  yearCertain: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

function ymdOf(c: chrono.ParsedComponents): string {
  return `${c.get('year')}-${pad(c.get('month') || 1)}-${pad(c.get('day') || 1)}`;
}

function timeOf(c: chrono.ParsedComponents): string | undefined {
  if (!c.isCertain('hour')) return undefined;
  return `${pad(c.get('hour') || 0)}:${pad(c.get('minute') || 0)}`;
}

/** The dates in `text`, in order. `referenceYmd` places dates written without a year. */
export function detectDates(text: string, referenceYmd: string): DetectedDate[] {
  if (!text) return [];
  const [y, m, d] = referenceYmd.split('-').map(Number);
  const reference = new Date(y, m - 1, d, 12);
  const out: DetectedDate[] = [];
  for (const result of chrono.strict.parse(text, reference)) {
    const start = result.start;
    if (!start.isCertain('month') || !start.isCertain('day')) continue;
    if (!new RegExp(TOKEN.source, 'i').test(result.text)) continue;
    const found: DetectedDate = {
      text: result.text,
      index: result.index,
      date: ymdOf(start),
      yearCertain: start.isCertain('year'),
    };
    const startTime = timeOf(start);
    if (startTime) found.startTime = startTime;
    if (result.end) {
      const endDate = ymdOf(result.end);
      if (endDate > found.date) found.endDate = endDate;
      const endTime = timeOf(result.end);
      if (endTime) found.endTime = endTime;
    }
    out.push(found);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rewriting a date in the style it was written in
// ---------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept(?:ember)?|sep|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

/** An optional weekday before a date ("Tuesday, ", "Sat. "), as groups <p>Wd, <p>WdDot and <p>WdSep. */
const weekdayGroup = (p: string) =>
  `(?:(?<${p}Wd>(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?)(?<${p}WdDot>\\.?)(?<${p}WdSep>,?\\s+))?`;

// One token per written date: ISO, month first ("Sept. 1, 2026"), day first ("1 September") or m/d[/y].
const TOKEN = new RegExp([
  '(?<iso>\\b\\d{4}-\\d{2}-\\d{2}\\b)',
  `(?<named>\\b${weekdayGroup('n')}(?<nMonth>${MONTH})(?<nDot>\\.?)\\s+(?<nDay>\\d{1,2})(?<nOrd>st|nd|rd|th)?(?![\\d:])` +
    '(?:(?<nYsep>,?\\s+)(?<nYear>\\d{4})\\b)?)',
  `(?<dayFirst>\\b${weekdayGroup('d')}(?<dDay>\\d{1,2})(?<dOrd>st|nd|rd|th)?\\s+(?<dMonth>${MONTH})\\b(?<dDot>\\.?)` +
    '(?:(?<dYsep>,?\\s+)(?<dYear>\\d{4})\\b)?)',
  `(?<numeric>\\b${weekdayGroup('u')}(?<uM>\\d{1,2})\\/(?<uD>\\d{1,2})(?:\\/(?<uY>\\d{4}|\\d{2}))?(?![\\d:])(?!\\s*[ap]\\.?m\\b))`,
].join('|'), 'gi');

function titleLike(word: string, like: string): string {
  if (like === like.toUpperCase() && like.length > 1) return word.toUpperCase();
  if (like[0] === like[0].toLowerCase()) return word.toLowerCase();
  return word[0].toUpperCase() + word.slice(1);
}

function monthLike(month: number, written: string): string {
  const full = MONTHS[month - 1];
  const lower = written.toLowerCase();
  const name = MONTHS.includes(lower) && lower.length > 3 ? full : month === 9 && lower === 'sept' ? 'sept' : full.slice(0, 3);
  return titleLike(name, written);
}

function weekdayLike(ymdValue: string, written: string): string {
  const [y, m, d] = ymdValue.split('-').map(Number);
  const full = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const lower = written.toLowerCase();
  let name = full;
  if (!lower.endsWith('day')) name = lower.length === 4 && (full === 'tuesday' || full === 'thursday') ? full.slice(0, 4) : full.slice(0, 3);
  return titleLike(name, written);
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][day % 10] || 'th';
}

function rewriteToken(groups: Record<string, string | undefined>, ymdValue: string): string {
  const [y, m, d] = ymdValue.split('-').map(Number);
  const weekday = (wd?: string, dot?: string, sep?: string) => (wd ? `${weekdayLike(ymdValue, wd)}${dot || ''}${sep || ''}` : '');
  if (groups.iso) return ymdValue;
  if (groups.named) {
    const month = monthLike(m, groups.nMonth!);
    const dot = groups.nDot && month.length < MONTHS[m - 1].length ? '.' : '';
    const year = groups.nYear ? `${groups.nYsep}${y}` : '';
    return `${weekday(groups.nWd, groups.nWdDot, groups.nWdSep)}${month}${dot} ${d}${groups.nOrd ? ordinal(d) : ''}${year}`;
  }
  if (groups.dayFirst) {
    const month = monthLike(m, groups.dMonth!);
    const dot = groups.dDot && month.length < MONTHS[m - 1].length ? '.' : '';
    const year = groups.dYear ? `${groups.dYsep}${y}` : '';
    return `${weekday(groups.dWd, groups.dWdDot, groups.dWdSep)}${d}${groups.dOrd ? ordinal(d) : ''} ${month}${dot}${year}`;
  }
  const mm = groups.uM!.length === 2 ? pad(m) : String(m);
  const dd = groups.uD!.length === 2 ? pad(d) : String(d);
  const year = groups.uY ? `/${groups.uY.length === 2 ? String(y).slice(2) : y}` : '';
  return `${weekday(groups.uWd, groups.uWdDot, groups.uWdSep)}${mm}/${dd}${year}`;
}

export interface Rewrite {
  text: string;
  /** The times written differ from the occurrence's: the rewrite kept them, so they need a hand edit. */
  timesDiffer: boolean;
}

/**
 * `found` (a date as written) moved to `next`, in the same style: month names, abbreviations,
 * ordinals, weekdays and years as written; times and other words unchanged. A written range keeps
 * its length unless `next` has its own end date. Null when no date in the text can be rewritten.
 */
export function rewriteDate(found: DetectedDate, next: Occurrence): Rewrite | null {
  const tokens = Array.from(found.text.matchAll(TOKEN));
  if (!tokens.length) return null;
  const end = next.endDate
    || (found.endDate ? addDays(next.date, daysBetween(found.date, found.endDate)) : undefined);
  const targets = [next.date, end || next.date];
  let text = '';
  let last = 0;
  tokens.slice(0, 2).forEach((token, i) => {
    text += found.text.slice(last, token.index!) + rewriteToken(token.groups || {}, targets[i]);
    last = token.index! + token[0].length;
  });
  text += found.text.slice(last);
  const timesDiffer = (!!found.startTime && !!next.startTime && found.startTime !== next.startTime)
    || (!!found.endTime && !!next.endTime && found.endTime !== next.endTime);
  return { text, timesDiffer };
}

// ---------------------------------------------------------------------------
// A name for a date, from the sentence it was written in
// ---------------------------------------------------------------------------

/** Words that tie a phrase to its date ("register by", "at HQ on", "is due"), trimmed from the ends. */
const CONNECTOR = '(?:by|on|at|from|until|till|through|thru|before|after|starting|starts|begins|is|are|was|will be|be|due|of|for|and|to|in)';
const TRAILING = new RegExp(`(?:[\\s,:;(\\-–—]+|\\s+${CONNECTOR})+$`, 'i');
const LEADING = new RegExp(`^(?:[\\s,:;)\\-–—]+|${CONNECTOR}\\s+)+`, 'i');
const MAX_NAME = 80;
const MAX_NAME_WORDS = 8;

function tidy(phrase: string): string {
  // Asides in parentheses aren't part of a name (an unclosed one runs to the end)
  let out = phrase.replace(/\s*\([^)]*(\)|$)/g, '').replace(/\s+/g, ' ');
  for (let previous = ''; previous !== out;) {
    previous = out;
    out = out.replace(TRAILING, '').replace(LEADING, '');
  }
  return out.trim();
}

/**
 * What a date is for, from the words around it in its sentence: the words before it ("Claim your
 * Ranger tickets by July 31st" → "Claim your Ranger tickets"), else the words after ("July 31st:
 * ticket deadline" → "Ticket deadline"). Empty when the sentence has nothing else in it.
 */
export function suggestDateName(text: string, found: Pick<DetectedDate, 'index' | 'text'>): string {
  const end = found.index + found.text.length;
  const before = text.slice(0, found.index);
  const boundary = /[.!?](?=\s)|\n/g;
  let start = 0;
  for (let match = boundary.exec(before); match; match = boundary.exec(before)) start = match.index + 1;
  const afterText = text.slice(end);
  const stop = afterText.search(/[.!?](?=\s|$)|\n/);
  const words = (phrase: string) => phrase.split(' ').filter(Boolean).length;
  const lead = tidy(before.slice(start));
  const trail = tidy(stop === -1 ? afterText : afterText.slice(0, stop));
  let name = words(lead) >= 2 || !trail ? lead : trail;
  // A name, not the sentence: its first few words
  const parts = name.split(' ');
  if (parts.length > MAX_NAME_WORDS) name = tidy(parts.slice(0, MAX_NAME_WORDS).join(' '));
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).replace(/\s+\S*$/, '');
  return name ? name[0].toUpperCase() + name.slice(1) : '';
}

// ---------------------------------------------------------------------------
// Where a date is in its text
// ---------------------------------------------------------------------------

/** How many times `found.text` appears in `text` before this match (to find the same one in the editor). */
export function occurrenceIndex(text: string, found: Pick<DetectedDate, 'index' | 'text'>): number {
  let count = 0;
  for (let at = text.indexOf(found.text); at !== -1 && at < found.index; at = text.indexOf(found.text, at + 1)) count++;
  return count;
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

/** The date with up to `radius` characters either side within its paragraph, cut at words, on one line. */
export function dateSnippet(text: string, found: Pick<DetectedDate, 'index' | 'text'>, radius = 60): Snippet {
  const oneLine = (value: string) => value.replace(/\s+/g, ' ');
  const matchEnd = found.index + found.text.length;
  const paragraphStart = text.lastIndexOf('\n', found.index - 1) + 1;
  const nextBreak = text.indexOf('\n', matchEnd);
  const paragraphEnd = nextBreak === -1 ? text.length : nextBreak;
  const from = Math.max(paragraphStart, found.index - radius);
  const to = Math.min(paragraphEnd, matchEnd + radius);
  let before = text.slice(from, found.index);
  let after = text.slice(matchEnd, to);
  // Drop a word cut in half (unless the window starts or ends exactly between words)
  if (from > paragraphStart) before = `…${/\s/.test(text[from - 1]) ? before : before.replace(/^\S*\s/, '')}`;
  if (to < paragraphEnd) after = `${/\s/.test(text[to]) ? after : after.replace(/\s\S*$/, '')}…`;
  return { before: oneLine(before), match: found.text, after: oneLine(after) };
}
