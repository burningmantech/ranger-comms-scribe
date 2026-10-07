import { ContentSubmission } from '../types';
import { TrackedChange, currentFormFieldValue } from '../services/trackedChangesService';

/**
 * The request form's audience keys and the labels it stores in formFields.audience
 * (frontend CommsRequest.tsx / TrackedChangesEditor.tsx keep the same maps).
 */
export const AUDIENCE_LABELS: Record<string, string> = {
  newsletter: 'Include in Ranger Newsletter (sent over Ranger Announce)',
  singular: 'Singular announcement (outside of Ranger Newsletter)',
  allcom: 'Allcom',
  website_fix: 'Website - fix',
  website_update: 'Website - new or changed content',
  jrs: 'JRS/Event Ops/Other BMP Audience',
  event: "Let's plan an event",
  other: 'Other',
};

// Older labels that may be stored on submissions
const EXTRA_LABELS: Record<string, string> = {
  'Website - update': 'website_update',
  'Ranger Newsletter': 'newsletter',
  Newsletter: 'newsletter',
};

const LABEL_TO_KEY: Record<string, string> = {
  ...Object.fromEntries(Object.entries(AUDIENCE_LABELS).map(([key, label]) => [label, key])),
  ...EXTRA_LABELS,
};

/** Audiences that go out as their own email to Announce. The newsletter goes out in an edition. */
export const STANDALONE_EMAIL_AUDIENCES: ReadonlySet<string> = new Set(['singular', 'allcom']);

/** Keys for a stored audience value: keys, labels, "Other: ..." or a comma-separated string of those. */
export function parseAudienceKeys(value: string | string[] | undefined | null): string[] {
  if (value === undefined || value === null) return [];
  let parts: string[];
  if (Array.isArray(value)) {
    parts = value;
  } else {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        parts = Array.isArray(parsed) ? parsed.map(String) : [trimmed];
      } catch {
        parts = trimmed.split(',');
      }
    } else {
      parts = trimmed.split(',');
    }
  }
  const keys: string[] = [];
  for (const raw of parts) {
    const part = String(raw).trim();
    if (!part) continue;
    let key = part;
    if (AUDIENCE_LABELS[part]) key = part;
    else if (LABEL_TO_KEY[part]) key = LABEL_TO_KEY[part];
    else if (part.startsWith('Other:')) key = 'other';
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * A submission's audience keys. A reviewer's Audience change (pending or approved) wins,
 * then the `audiences` keys saved by the form, then the labels in formFields.audience.
 */
export function audienceKeys(submission: ContentSubmission, changes: TrackedChange[] = []): string[] {
  const changed = currentFormFieldValue(changes, 'audience');
  if (changed !== null) return parseAudienceKeys(changed);
  if (Array.isArray(submission.audiences) && submission.audiences.length > 0) {
    return parseAudienceKeys(submission.audiences);
  }
  const field = (submission.formFields || []).find((f) => f.id === 'audience')
    || (submission.formFields || []).find((f) => (f.label || '').toLowerCase() === 'audience');
  return parseAudienceKeys(field?.value as string | string[] | undefined);
}
