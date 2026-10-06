import { CommsCalendarInput, CommsMethod } from '../types/commsCalendar';
import { isValidEmail, splitEmails } from './commsCalendar';

// Turns the Comms spreadsheet ("Announce Messages and Comms Queue", exported as CSV) into
// calendar entries. Columns are found by their headers; dates like "Sep-14" carry no year,
// so the year comes from the Sep→Aug cycle the sheet covers.

type Field = 'subject' | 'targetDate' | 'method' | 'dateSent' | 'team' | 'comments' | 'link' | 'contactEmails';

// Checked in this order for each header, so "Email subject" is the subject, not contacts
const HEADER_MATCHERS: Array<[Field, RegExp]> = [
  ['subject', /subject|title/],
  ['targetDate', /target|publish ?by/],
  ['dateSent', /sent/],
  ['method', /method|publish|channel/],
  ['team', /team|responsible|owner/],
  ['comments', /comment|milestone|note/],
  ['link', /link|url/],
  ['contactEmails', /contact|^e-?mails?$/],
];

export type ColumnMap = Partial<Record<Field, number>>;

/** Which column holds which field (the first matching column wins). */
export function mapColumns(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  header.forEach((raw, index) => {
    const name = raw.trim().toLowerCase();
    if (!name) return;
    const match = HEADER_MATCHERS.find(([field, re]) => map[field] === undefined && re.test(name));
    if (match) map[match[0]] = index;
  });
  return map;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const EMPTY_DATE = /^(n\/?a|tbd|tba|none|-+|—)$/i;

function monthNumber(name: string): number | undefined {
  return MONTHS[name.slice(0, 3).toLowerCase()];
}

function fullYear(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return value.length <= 2 ? 2000 + n : n;
}

export interface ParsedDate {
  date?: string;
  warning?: string;
}

/**
 * A date cell as YYYY-MM-DD. Without a year, Sep–Dec belong to `cycleStartYear` and
 * Jan–Aug to the year after. Blank and "N/A" give no date; anything else that isn't a
 * date gives a warning.
 */
export function parseSheetDate(raw: string, cycleStartYear: number): ParsedDate {
  const value = raw.trim();
  if (!value || EMPTY_DATE.test(value)) return {};

  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value))) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(value))) {
    [month, day, year] = [Number(match[1]), Number(match[2]), fullYear(match[3])];
  } else if ((match = /^([a-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?(?:,?[\s-]+(\d{2}|\d{4}))?$/i.exec(value))) {
    [month, day, year] = [monthNumber(match[1]), Number(match[2]), fullYear(match[3])];
  } else if ((match = /^(\d{1,2})[\s-]+([a-z]{3,9})\.?(?:[\s-]+(\d{2}|\d{4}))?$/i.exec(value))) {
    [day, month, year] = [Number(match[1]), monthNumber(match[2]), fullYear(match[3])];
  }
  if (!month || !day || month > 12) return { warning: `"${value}" is not a date` };

  let warning: string | undefined;
  if (year === undefined) year = month >= 9 ? cycleStartYear : cycleStartYear + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > lastDay) {
    if (month === 2 && day === 29) {
      day = 28;
      warning = `${year} has no Feb 29; using Feb 28`;
    } else {
      return { warning: `"${value}" is not a date` };
    }
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${year}-${pad(month)}-${pad(day)}`, ...(warning ? { warning } : {}) };
}

/** Announce / Newsletter / Both / N/A, case-insensitively; anything else is N/A with a warning. */
export function normalizeMethod(raw: string): { method: CommsMethod; warning?: string } {
  const value = raw.trim().toLowerCase();
  if (!value || value === 'n/a' || value === 'na' || value === 'none') return { method: 'N/A' };
  if (value === 'both') return { method: 'Both' };
  if (value.startsWith('announce')) return { method: 'Announce' };
  if (value.startsWith('newsletter')) return { method: 'Newsletter' };
  return { method: 'N/A', warning: `Unknown method "${raw.trim()}"; using N/A` };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ImportRow {
  /** Row number in the sheet (the header is row 1). */
  line: number;
  input: CommsCalendarInput;
  warnings: string[];
}

export interface ParsedSheet {
  columns: ColumnMap;
  rows: ImportRow[];
  /** Set when the file can't be imported at all. */
  error?: string;
}

/** Rows (header first, as from parseCsv) → entries to import, with warnings per row. */
export function sheetToEntries(table: string[][], cycleStartYear: number): ParsedSheet {
  if (table.length === 0) return { columns: {}, rows: [], error: 'The file is empty' };
  const columns = mapColumns(table[0]);
  if (columns.subject === undefined) {
    return { columns, rows: [], error: 'No subject column found (a header containing "Subject")' };
  }

  const rows = table.slice(1).map((cells, i): ImportRow => {
    const cell = (field: Field) => {
      const index = columns[field];
      return index === undefined ? '' : (cells[index] ?? '').trim();
    };
    const warnings: string[] = [];
    const extraComments: string[] = [];
    const input: CommsCalendarInput = {
      subject: cell('subject'),
      team: cell('team'),
      comments: cell('comments'),
    };

    for (const [field, label] of [['targetDate', 'Target date'], ['dateSent', 'Date sent']] as const) {
      const raw = cell(field);
      const parsed = parseSheetDate(raw, cycleStartYear);
      if (parsed.date) input[field] = parsed.date;
      if (parsed.warning) warnings.push(`${label}: ${parsed.warning}`);
      // Notes typed in a date column ("Sent by VCs") move to the comments
      if (!parsed.date && parsed.warning) extraComments.push(`${label}: ${raw}`);
    }

    const method = normalizeMethod(cell('method'));
    input.method = method.method;
    if (method.warning) warnings.push(method.warning);

    const link = cell('link');
    if (link) {
      if (isHttpUrl(link)) input.link = link;
      else {
        warnings.push(`Link "${link}" is not a web address`);
        extraComments.push(`Link: ${link}`);
      }
    }

    const emails = splitEmails(cell('contactEmails'));
    const bad = emails.filter((email) => !isValidEmail(email));
    if (bad.length > 0) warnings.push(`Not email addresses: ${bad.join(', ')}`);
    input.contactEmails = emails.filter(isValidEmail);

    // A row with no dates still belongs to the sheet's cycle
    if (!input.targetDate && !input.dateSent) input.cycleYear = cycleStartYear;

    if (extraComments.length > 0) {
      input.comments = [input.comments, ...extraComments].filter(Boolean).join('; ');
    }
    if (!input.subject) warnings.push('No subject; this row will be skipped');
    return { line: i + 2, input, warnings };
  });

  return { columns, rows };
}
