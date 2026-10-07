import { isLexicalJson } from './lexicalUtils';

/** What originalDocument reads from a submission (frontend or raw backend shape). */
export interface OriginalContentSource {
  content?: string;
  richTextContent?: string;
  originalContent?: string;
  originalRichTextContent?: string;
  changes?: Array<{ field?: string; status?: string; timestamp?: Date | string; richTextOldValue?: string }>;
}

const lexical = (value: unknown): value is string => typeof value === 'string' && value !== '' && isLexicalJson(value);
const time = (t: Date | string | undefined): number => {
  const ms = t instanceof Date ? t.getTime() : t ? new Date(t).getTime() : NaN;
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
};

/**
 * The document as it was submitted (Lexical JSON, or plain text for submissions stored
 * without rich text): what the review tool's Original view shows and Compare diffs against.
 *
 * Accepting or rejecting a change rewrites the submission's content / richTextContent on the
 * server, so those are the document with the decided changes applied, not the original.
 *
 * 1. originalContent / originalRichTextContent: set when the submission is created and never
 *    changed (Lexical content wins, as when the submission is loaded).
 * 2. Older submissions: the earliest content change's richTextOldValue (the document before
 *    any tracked change).
 * 3. No changes yet: nothing has rewritten the content, so the current value is the original.
 */
export function originalDocument(submission: OriginalContentSource): string {
  const { originalContent, originalRichTextContent } = submission;
  if (originalContent !== undefined || originalRichTextContent !== undefined) {
    if (lexical(originalContent)) return originalContent;
    return originalRichTextContent || originalContent || '';
  }

  let earliest: { at: number; value: string } | null = null;
  for (const change of submission.changes || []) {
    if (change.field && change.field !== 'content') continue;
    if (!lexical(change.richTextOldValue)) continue;
    const at = time(change.timestamp);
    if (!earliest || at < earliest.at) earliest = { at, value: change.richTextOldValue };
  }
  if (earliest) return earliest.value;

  return submission.richTextContent || submission.content || '';
}
