import type { Change } from '../types/content';

/** The tracked-change fields that hold a request's form values, not the document. */
export const FORM_FIELD_CHANGE_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'audience',
  'replyToAddress',
  'signatureText',
]);

const timeOf = (t: Date | string | undefined): number => (t ? new Date(t).getTime() : 0);

/** A form-field change's whole new value (the server keeps only the changed words in newValue). */
export function wholeFieldValue(change: Change): string {
  return typeof change.completeProposedVersion === 'string'
    ? change.completeProposedVersion
    : change.newValue;
}

/**
 * The current proposed value of a form field (Subject, Audience, Reply-To, Signature): the
 * whole value of the newest change to it that isn't rejected, pending or accepted. Null
 * when there is none, so the caller shows the value as submitted. Once every change is
 * resolved this is the approved value the announcement email uses.
 */
export function currentFormFieldValue(changes: Change[], field: string): string | null {
  let newest: Change | null = null;
  for (const change of changes) {
    if (change.field !== field || change.status === 'rejected') continue;
    if (typeof wholeFieldValue(change) !== 'string') continue;
    if (!newest || timeOf(change.timestamp) >= timeOf(newest.timestamp)) newest = change;
  }
  return newest ? wholeFieldValue(newest) : null;
}
