/** Annual dates (things that happen every year) and a request's links to them; mirrors backend/src/types.ts. */

/** The same calendar date every year, or a number of days from Labor Day (the Burn is Labor Day - 2). */
export type AnnualDateRule =
  | { kind: 'fixed'; month: number; day: number }
  | { kind: 'laborDay'; offsetDays: number };

/** One year's date when it moved away from the rule. */
export interface AnnualDateOverride {
  date: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  note?: string;
}

export interface AnnualDate {
  id: string;
  name: string;
  rule: AnnualDateRule;
  /** Days after the start that it ends. */
  durationDays?: number;
  /** Wall-clock "HH:mm", Pacific. */
  startTime?: string;
  endTime?: string;
  /** By year ("2027"). */
  overrides?: Record<string, AnnualDateOverride>;
  notes?: string;
  link?: string;
  createdFrom?: { submissionId: string; text: string };
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt: string;
}

/** What POST and PUT take (null clears a field on PUT). */
export type AnnualDateInput = {
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

/** A date written in a request's body or blurb, linked to an annual date. */
export interface DateLink {
  id: string;
  annualDateId: string;
  field: 'body' | 'blurb';
  /** The date as written ("Sept. 1 2026"). */
  text: string;
  /** The year of the occurrence the text was written for. */
  year: number;
}
