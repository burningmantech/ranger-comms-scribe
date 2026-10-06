// Comms Calendar: mirrors CommsCalendarEntry in backend/src/types.ts

import { DateLink } from './annualDates';

export type CommsMethod = 'Announce' | 'Newsletter' | 'Both' | 'N/A';

export const COMMS_METHODS: CommsMethod[] = ['Announce', 'Newsletter', 'Both', 'N/A'];

export interface CommsCalendarNudge {
  at: string;
  by: string;
  byName: string;
  to: string[];
  note?: string;
}

export interface CommsCalendarEntry {
  id: string;
  subject: string;
  link?: string;
  /** YYYY-MM-DD */
  targetDate?: string;
  /** YYYY-MM-DD */
  dateSent?: string;
  /** The cycle (start year) of an entry with neither date. */
  cycleYear?: number;
  method: CommsMethod;
  team: string;
  contactEmails: string[];
  comments: string;
  submissionId?: string;
  /** The Ranger News edition its newsletter item went out in. */
  newsletterSentIn?: number;
  carriedFromId?: string;
  notRepeating?: boolean;
  /** The message's text (plain, a line per paragraph), pasted or imported from its document, for its dates. */
  documentText?: string;
  /** Dates in documentText linked to annual dates. */
  dateLinks?: DateLink[];
  nudges: CommsCalendarNudge[];
  source: 'manual' | 'import' | 'submission';
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

/** What the form and the import send. null (or '') clears an optional field. */
export interface CommsCalendarInput {
  subject?: string;
  link?: string | null;
  targetDate?: string | null;
  dateSent?: string | null;
  cycleYear?: number | null;
  method?: CommsMethod;
  team?: string;
  contactEmails?: string[];
  comments?: string;
  submissionId?: string | null;
  carriedFromId?: string | null;
  notRepeating?: boolean;
  documentText?: string | null;
  dateLinks?: DateLink[];
}

export interface UpcomingItem {
  entry: CommsCalendarEntry;
  /** 'planned': its own date, not sent yet. 'anniversary': a past entry due again. */
  kind: 'planned' | 'anniversary';
  /** The planned target date, or the anniversary */
  anniversary: string;
  daysUntil: number;
  overdue: boolean;
}

export interface ImportResult {
  created: number;
  skipped: Array<{ index: number; reason: string }>;
  entries: CommsCalendarEntry[];
}
