/**
 * The hints a resolve (approve / reject) passes to TrackedChangesPlugin's resolve handler,
 * computed from a change record: the deleted and inserted text (for the legacy marker and
 * text heuristics) and the formatting changes (for the legacy format revert).
 *
 * Pure, so it can be tested on its own and with the editors.
 */
import { diffCharsOptimized } from './diffAlgorithm';
import { extractTextFromLexical, isLexicalJson } from './lexicalUtils';
import { collectTextNodes, detectInlineFormatChanges } from './changeDescriptions';
import { matchBlocks } from './typedText';

export interface ResolveHintChange {
  oldValue?: string;
  newValue?: string;
  richTextOldValue?: string;
  richTextNewValue?: string;
}

export interface FormatChangeHint {
  type?: 'block' | 'inline' | 'indent';
  text: string;
  fromType: string;
  fromTag?: string;
  toType: string;
  toTag?: string;
  fromFormat?: number;
  toFormat?: number;
  fromIndent?: number;
  toIndent?: number;
  blockIndex?: number;
}

export interface ResolveHints {
  deletedTexts: string[];
  replacementPairs: Array<{ deleted: string; inserted: string }>;
  insertedTexts: Array<{ text: string; beforeContext: string; afterContext: string }>;
  formatChanges: FormatChangeHint[];
}

/** Plain text of a stored value (Lexical JSON or plain text), as TrackedChangesEditor shows it. */
export function displayableText(content: string): string {
  if (!content) return '';
  if (isLexicalJson(content)) return extractTextFromLexical(content);
  return content;
}

export interface ResolveHintOptions {
  /** Collaborative mode. */
  collab?: boolean;
  /** Plain text of a stored value (default: displayableText). */
  getText?: (content: string) => string;
}

/**
 * Pairs (old index, new index) of top-level blocks to compare for format changes: the
 * blocks with equal keys (longest common subsequence), plus the blocks between two such
 * matches when both sides have the same number of them (edited in place, paired by
 * position). A run of blocks inserted or removed pairs with nothing.
 */
export function pairBlocks(oldKeys: string[], newKeys: string[]): Array<[number, number]> {
  const matches = matchBlocks(oldKeys, newKeys);
  const pairs: Array<[number, number]> = [];
  let prevO = -1;
  let prevN = -1;
  for (const [o, n] of [...matches, [oldKeys.length, newKeys.length] as [number, number]]) {
    const gapO = o - prevO - 1;
    const gapN = n - prevN - 1;
    if (gapO > 0 && gapO === gapN) {
      for (let k = 1; k <= gapO; k++) pairs.push([prevO + k, prevN + k]);
    }
    if (o < oldKeys.length) pairs.push([o, n]);
    prevO = o;
    prevN = n;
  }
  return pairs;
}

export function buildResolveHints(change: ResolveHintChange | undefined, options: ResolveHintOptions = {}): ResolveHints {
  const getText = options.getText ?? displayableText;
  // Compute deleted text segments so the handler can match __pending_deletion__ nodes.
  // Also compute replacement pairs (adjacent delete→insert) so the reject handler
  // can remove inserted text that corresponds to each deletion.
  let deletedTexts: string[] = [];
  let replacementPairs: Array<{ deleted: string; inserted: string }> = [];
  let insertedTexts: Array<{ text: string; beforeContext: string; afterContext: string }> = [];
  if (change) {
    const rawOld = change.richTextOldValue || change.oldValue || '';
    const rawNew = change.richTextNewValue || change.newValue || '';
    const oldText = getText(rawOld);
    const newText = getText(rawNew);
    if (oldText && newText) {
      const segments = diffCharsOptimized(oldText, newText);
      deletedTexts = segments
        .filter(s => s.type === 'delete')
        .map(s => s.value.replace(/^\n+|\n+$/g, ''))
        .filter(t => t.length > 0);

      // Build replacement pairs: adjacent (delete, insert) segments form a pair.
      // When rejecting, we need to remove the inserted text alongside restoring
      // the deleted text, otherwise both end up in the document.
      const pairedInsertIndices = new Set<number>();
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].type === 'delete' && i + 1 < segments.length && segments[i + 1].type === 'insert') {
          const del = segments[i].value.replace(/^\n+|\n+$/g, '');
          const ins = segments[i + 1].value.replace(/^\n+|\n+$/g, '');
          if (del.length > 0 && ins.length > 0) {
            replacementPairs.push({ deleted: del, inserted: ins });
            pairedInsertIndices.add(i + 1);
          }
        }
      }

      // Build insertedTexts: pure inserts NOT part of a delete→insert replacement pair.
      // These are additions that have no corresponding DeletedTextNode, so the
      // resolve-tracked-change handler needs to find and remove them from TextNodes.
      let newOffset = 0;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.type === 'equal') {
          newOffset += seg.value.length;
        } else if (seg.type === 'insert') {
          if (!pairedInsertIndices.has(i) && seg.value.trim().length > 0) {
            // Get after-context within the same paragraph for precise matching
            const afterAll = newText.slice(newOffset + seg.value.length);
            const nlIdx = afterAll.indexOf('\n');
            const afterCtx = nlIdx >= 0 ? afterAll.slice(0, Math.min(nlIdx, 30)) : afterAll.slice(0, 30);
            // Get before-context within the same paragraph
            const beforeAll = newText.slice(0, newOffset);
            const lastNl = beforeAll.lastIndexOf('\n');
            const beforeCtx = lastNl >= 0 ? beforeAll.slice(lastNl + 1) : beforeAll.slice(-30);
            insertedTexts.push({ text: seg.value, beforeContext: beforeCtx, afterContext: afterCtx });
          }
          newOffset += seg.value.length;
        }
        // 'delete' segments don't advance newOffset
      }
    }
  }

  // Detect formatting-only changes (block type + inline format) so the
  // resolve handler can revert them on rejection.
  // Collaborative mode rejects by context and never runs the format revert: none needed.
  const formatChanges: FormatChangeHint[] = [];
  if (!options.collab && change && change.richTextOldValue && change.richTextNewValue) {
    try {
      const oldJson = isLexicalJson(change.richTextOldValue) ? JSON.parse(change.richTextOldValue) : null;
      const newJson = isLexicalJson(change.richTextNewValue) ? JSON.parse(change.richTextNewValue) : null;
      if (oldJson?.root?.children && newJson?.root?.children) {
        // Helper to extract text from any block (paragraph, heading, list, etc.)
        // Must match Lexical's getTextContent() behavior for reliable block matching.
        const extractBlockText = (block: any): string => {
          if (!block.children) return '';
          return block.children
            .map((n: any) => {
              if (n.type === 'text') return n.text || '';
              if (n.type === 'linebreak') return '\n';
              if (n.type === 'tab') return '\t';
              if (n.children) return extractBlockText(n);
              return '';
            })
            .join('');
        };

        // Compare all top-level blocks (not just paragraphs/headings), aligned by content
        // (pairBlocks) so that blocks inserted or removed above don't pair unrelated blocks.
        const oldBlocks = oldJson.root.children;
        const newBlocks = newJson.root.children;
        const blockKey = (b: any): string => (Array.isArray(b?.children) ? 't' + extractBlockText(b) : 'o' + JSON.stringify(b));
        for (const [oi, ni] of pairBlocks(oldBlocks.map(blockKey), newBlocks.map(blockKey))) {
          // Block type changes (paragraph <-> heading, heading tag changes)
          if (oldBlocks[oi].type !== newBlocks[ni].type || oldBlocks[oi].tag !== newBlocks[ni].tag) {
            const blockText = extractBlockText(newBlocks[ni]);
            formatChanges.push({
              type: 'block',
              text: blockText,
              blockIndex: ni,
              fromType: oldBlocks[oi].type,
              fromTag: oldBlocks[oi].tag,
              toType: newBlocks[ni].type,
              toTag: newBlocks[ni].tag,
            });
          }

          // Indent changes on the block itself
          if ((oldBlocks[oi].indent ?? 0) !== (newBlocks[ni].indent ?? 0)) {
            const blockText = extractBlockText(newBlocks[ni]);
            formatChanges.push({
              type: 'indent',
              text: blockText,
              fromType: newBlocks[ni].type,
              toType: newBlocks[ni].type,
              fromIndent: oldBlocks[oi].indent ?? 0,
              toIndent: newBlocks[ni].indent ?? 0,
            });
          }

          // Indent changes on children (e.g. list items inside list nodes)
          if (oldBlocks[oi].children && newBlocks[ni].children) {
            const detectChildIndentChanges = (oldChildren: any[], newChildren: any[]) => {
              for (let j = 0; j < Math.min(oldChildren.length, newChildren.length); j++) {
                if ((oldChildren[j].indent ?? 0) !== (newChildren[j].indent ?? 0)) {
                  const itemText = extractBlockText(newChildren[j]);
                  formatChanges.push({
                    type: 'indent',
                    text: itemText,
                    fromType: newChildren[j].type,
                    toType: newChildren[j].type,
                    fromIndent: oldChildren[j].indent ?? 0,
                    toIndent: newChildren[j].indent ?? 0,
                  });
                }
                // Recurse into nested children
                if (oldChildren[j].children && newChildren[j].children) {
                  detectChildIndentChanges(oldChildren[j].children, newChildren[j].children);
                }
              }
            };
            detectChildIndentChanges(oldBlocks[oi].children, newBlocks[ni].children);
          }

          // Inline format changes — character-level comparison handles node splits
          // Use recursive collectTextNodes to handle nested structures (lists, links)
          const oldTexts = collectTextNodes(oldBlocks[oi]);
          const newTexts = collectTextNodes(newBlocks[ni]);
          const inlineChanges = detectInlineFormatChanges(oldTexts, newTexts);
          for (const ic of inlineChanges) {
            formatChanges.push({
              type: 'inline',
              text: ic.text,
              fromType: 'text',
              toType: 'text',
              fromFormat: ic.fromFormat,
              toFormat: ic.toFormat,
            });
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return { deletedTexts, replacementPairs, insertedTexts, formatChanges };
}
