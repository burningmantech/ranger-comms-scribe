/**
 * Plain-language descriptions of tracked changes for the review sidebar:
 * "Added: …", "Deleted: …", "Replaced 'x' with 'y'", "Moved: …", "Formatted: …".
 *
 * A change record holds the whole document before and after the edit (rich text, with
 * plain-text copies). The description diffs the two plain texts: the common prefix and
 * suffix are dropped (cheap, and keeps whole-document records fast), then the middle is
 * diffed word by word.
 */
import { extractTextFromLexical, isLexicalJson } from './lexicalUtils';

// ---------------------------------------------------------------------------
// Format-only changes (moved here from TrackedChangesEditor)
// ---------------------------------------------------------------------------

// Lexical format bitmask constants
const FORMAT_BOLD = 1;
const FORMAT_ITALIC = 2;
const FORMAT_STRIKETHROUGH = 4;
const FORMAT_UNDERLINE = 8;

const FORMAT_NAMES: Record<number, string> = {
  [FORMAT_BOLD]: 'bold',
  [FORMAT_ITALIC]: 'italic',
  [FORMAT_STRIKETHROUGH]: 'strikethrough',
  [FORMAT_UNDERLINE]: 'underline',
};

const HEADING_TAG_NAMES: Record<string, string> = {
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
};

/**
 * Recursively collect all text nodes from a JSON subtree.
 * Handles nested structures (list items, links, etc.) that have text nodes
 * deeper than direct children.
 */
export const collectTextNodes = (node: any): any[] => {
  if (node.type === 'text') return [node];
  if (!node.children) return [];
  return node.children.flatMap((child: any) => collectTextNodes(child));
};

/**
 * Build a per-character format array from a block's text nodes.
 * Each element is the Lexical format bitmask for that character position.
 * This handles Lexical's text node splitting (e.g. bolding "nothing" splits
 * one node into three) by flattening to character level.
 */
const buildCharFormatMap = (textNodes: any[]): { formats: number[]; fullText: string } => {
  const formats: number[] = [];
  let fullText = '';
  for (const node of textNodes) {
    const text: string = node.text || '';
    const format: number = node.format || 0;
    for (let i = 0; i < text.length; i++) {
      formats.push(format);
    }
    fullText += text;
  }
  return { formats, fullText };
};

/**
 * Compare two blocks' text nodes at the character level and return
 * contiguous ranges where the format bitmask changed.
 */
export const detectInlineFormatChanges = (
  oldTextNodes: any[],
  newTextNodes: any[],
): Array<{ text: string; fromFormat: number; toFormat: number }> => {
  const oldMap = buildCharFormatMap(oldTextNodes);
  const newMap = buildCharFormatMap(newTextNodes);
  // Only compare if the plain text is identical (format-only change)
  if (oldMap.fullText !== newMap.fullText) return [];

  const results: Array<{ text: string; fromFormat: number; toFormat: number }> = [];
  let i = 0;
  while (i < oldMap.formats.length) {
    if (oldMap.formats[i] !== newMap.formats[i]) {
      // Start of a changed range
      const start = i;
      const fromFmt = oldMap.formats[i];
      const toFmt = newMap.formats[i];
      while (
        i < oldMap.formats.length &&
        oldMap.formats[i] === fromFmt &&
        newMap.formats[i] === toFmt
      ) {
        i++;
      }
      results.push({
        text: oldMap.fullText.substring(start, i),
        fromFormat: fromFmt,
        toFormat: toFmt,
      });
    } else {
      i++;
    }
  }
  return results;
};

/**
 * Compare richTextOldValue and richTextNewValue to produce human-readable
 * descriptions of format-only changes (block type and inline formatting).
 */
export const describeFormatChanges = (richTextOldValue?: string, richTextNewValue?: string): string[] => {
  if (!richTextOldValue || !richTextNewValue) return [];
  try {
    const oldJson = isLexicalJson(richTextOldValue) ? JSON.parse(richTextOldValue) : null;
    const newJson = isLexicalJson(richTextNewValue) ? JSON.parse(richTextNewValue) : null;
    if (!oldJson?.root?.children || !newJson?.root?.children) return [];

    const descriptions: string[] = [];
    const oldBlocks = oldJson.root.children.filter((n: any) => n.type === 'paragraph' || n.type === 'heading');
    const newBlocks = newJson.root.children.filter((n: any) => n.type === 'paragraph' || n.type === 'heading');

    for (let i = 0; i < Math.min(oldBlocks.length, newBlocks.length); i++) {
      const oldBlock = oldBlocks[i];
      const newBlock = newBlocks[i];

      // Block type changes (paragraph <-> heading, or heading tag changes)
      if (oldBlock.type !== newBlock.type || oldBlock.tag !== newBlock.tag) {
        const blockText = (newBlock.children || [])
          .filter((n: any) => n.type === 'text')
          .map((n: any) => n.text || '')
          .join('');
        // Skip empty blocks — no useful information to display
        if (!blockText.trim()) continue;
        const snippet = blockText.length > 40 ? blockText.substring(0, 40) + '...' : blockText;
        const fromLabel = oldBlock.type === 'heading' && oldBlock.tag
          ? HEADING_TAG_NAMES[oldBlock.tag] || oldBlock.tag
          : 'Paragraph';
        const toLabel = newBlock.type === 'heading' && newBlock.tag
          ? HEADING_TAG_NAMES[newBlock.tag] || newBlock.tag
          : 'Paragraph';
        descriptions.push(`Changed "${snippet}" from ${fromLabel} to ${toLabel}`);
      }

      // Inline format changes — character-level comparison handles node splits
      // Use recursive collectTextNodes to handle nested structures (lists, links)
      const oldTexts = collectTextNodes(oldBlock);
      const newTexts = collectTextNodes(newBlock);
      const inlineChanges = detectInlineFormatChanges(oldTexts, newTexts);
      for (const ic of inlineChanges) {
        const snippet = ic.text.length > 30 ? ic.text.substring(0, 30) + '...' : ic.text;
        for (const [bit, name] of Object.entries(FORMAT_NAMES)) {
          const bitNum = Number(bit);
          const wasSet = (ic.fromFormat & bitNum) !== 0;
          const isSet = (ic.toFormat & bitNum) !== 0;
          if (!wasSet && isSet) {
            descriptions.push(`Made "${snippet}" ${name}`);
          } else if (wasSet && !isSet) {
            descriptions.push(`Removed ${name} from "${snippet}"`);
          }
        }
      }
    }

    return descriptions;
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Text diff
// ---------------------------------------------------------------------------

/** Collapse runs of whitespace (including line breaks) and trim. */
export const normalizeText = (s: string): string => s.replace(/\s+/g, ' ').trim();

const isWordChar = (c: string | undefined): boolean => c !== undefined && /\S/.test(c);

/** Token LCS limit (tokens of old x tokens of new) before the middle is treated as replaced. */
const MAX_LCS_CELLS = 250_000;

/** The text a change removed and the text it added, as contiguous runs in document order. */
export interface TextDiff {
  deleted: string[];
  inserted: string[];
}

export function textDiff(oldText: string, newText: string): TextDiff {
  const a = oldText || '';
  const b = newText || '';
  if (a === b) return { deleted: [], inserted: [] };

  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // Don't split words: move the boundaries out to whitespace.
  while (p > 0 && isWordChar(a[p - 1]) && (isWordChar(a[p]) || isWordChar(b[p]))) p--;
  while (s > 0 && isWordChar(a[a.length - s]) &&
    (isWordChar(a[a.length - s - 1]) || isWordChar(b[b.length - s - 1]))) s--;

  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  if (!am) return { deleted: [], inserted: bm ? [bm] : [] };
  if (!bm) return { deleted: [am], inserted: [] };

  const at = am.split(/(\s+)/).filter((t) => t !== '');
  const bt = bm.split(/(\s+)/).filter((t) => t !== '');
  if (at.length * bt.length > MAX_LCS_CELLS) return { deleted: [am], inserted: [bm] };

  // LCS table over tokens (suffix lengths), then walk it.
  const n = at.length;
  const m = bt.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = at[i] === bt[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Array<{ type: 'eq' | 'del' | 'ins'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && at[i] === bt[j]) {
      ops.push({ type: 'eq', text: at[i] });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ type: 'ins', text: bt[j++] });
    } else {
      ops.push({ type: 'del', text: at[i++] });
    }
  }

  // Runs of edits; a shared whitespace token between two edits doesn't end a run
  // ("the quick" -> "a slow" is one replacement, not two).
  const deleted: string[] = [];
  const inserted: string[] = [];
  let del = '';
  let ins = '';
  let open = false;
  const flush = () => {
    if (del) deleted.push(del);
    if (ins) inserted.push(ins);
    del = '';
    ins = '';
    open = false;
  };
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === 'del') { del += op.text; open = true; continue; }
    if (op.type === 'ins') { ins += op.text; open = true; continue; }
    const glue = open && /^\s+$/.test(op.text) && k + 1 < ops.length && ops[k + 1].type !== 'eq';
    if (glue) {
      if (del) del += op.text;
      if (ins) ins += op.text;
      continue;
    }
    flush();
  }
  flush();
  return { deleted, inserted };
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

export type ChangeKind = 'added' | 'deleted' | 'replaced' | 'moved' | 'formatted';

export interface ChangeDescription {
  kind: ChangeKind;
  /** added / deleted / moved: the text. Empty for an added line break or space. */
  text: string;
  /** replaced: the old and the new text. */
  from?: string;
  to?: string;
  /** formatted: what changed ("Made "x" bold"). */
  details?: string[];
}

/** The subset of a change record the description needs. */
export interface DescribableChange {
  field?: string;
  oldValue?: string;
  newValue?: string;
  richTextOldValue?: string;
  richTextNewValue?: string;
}

const SEGMENT_JOIN = ' … ';

function displayText(rich?: string, plain?: string): string {
  const raw = rich || plain || '';
  return isLexicalJson(raw) ? extractTextFromLexical(raw) : raw;
}

function joinRuns(runs: string[]): string {
  return runs.map((r) => r.trim()).filter(Boolean).join(SEGMENT_JOIN);
}

/** Describe a change in plain language (see the module comment). */
export function describeChange(change: DescribableChange): ChangeDescription {
  if (change.field && change.field !== 'content') {
    // A form field (subject, audience, ...): the values are the whole old and new value.
    const from = (change.oldValue || '').trim();
    const to = (change.newValue || '').trim();
    if (!from && to) return { kind: 'added', text: to };
    if (from && !to) return { kind: 'deleted', text: from };
    return { kind: 'replaced', text: '', from, to };
  }

  const oldText = displayText(change.richTextOldValue, change.oldValue);
  const newText = displayText(change.richTextNewValue, change.newValue);
  if (oldText === newText) {
    const details = describeFormatChanges(change.richTextOldValue, change.richTextNewValue);
    return { kind: 'formatted', text: '', details: details.length > 0 ? details : ['Formatting changed'] };
  }

  const { deleted, inserted } = textDiff(oldText, newText);
  const del = joinRuns(deleted);
  const ins = joinRuns(inserted);
  if (!del && !ins) {
    // Only whitespace changed: a line break (Enter, or two paragraphs joined) or a space.
    const breaksIn = inserted.join('').split('\n').length - 1;
    const breaksOut = deleted.join('').split('\n').length - 1;
    if (breaksIn !== breaksOut) {
      return { kind: breaksIn > breaksOut ? 'added' : 'deleted', text: '', details: ['line break'] };
    }
    return inserted.join('').length >= deleted.join('').length
      ? { kind: 'added', text: '', details: ['space'] }
      : { kind: 'deleted', text: '', details: ['space'] };
  }
  if (!del) return { kind: 'added', text: ins };
  if (!ins) return { kind: 'deleted', text: del };
  if (normalizeText(del) === normalizeText(ins)) return { kind: 'moved', text: ins };
  return { kind: 'replaced', text: '', from: del, to: ins };
}

/** A one-line summary, e.g. for the History list and toasts: `Replaced "a" with "b"`. */
export function summarizeDescription(d: ChangeDescription, maxLength = 60): string {
  const cut = (s: string) => (s.length > maxLength ? s.slice(0, maxLength - 1).trimEnd() + '…' : s);
  switch (d.kind) {
    case 'added': return d.text ? `Added "${cut(d.text)}"` : `Added a ${d.details?.[0] ?? 'line break'}`;
    case 'deleted': return d.text ? `Deleted "${cut(d.text)}"` : `Deleted a ${d.details?.[0] ?? 'line break'}`;
    case 'moved': return `Moved "${cut(d.text)}"`;
    case 'replaced': return `Replaced "${cut(d.from || '')}" with "${cut(d.to || '')}"`;
    case 'formatted': return `Formatted: ${cut((d.details || []).join('; '))}`;
    default: return '';
  }
}
