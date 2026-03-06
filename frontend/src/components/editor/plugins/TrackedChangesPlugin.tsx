import { useEffect, useRef, useCallback } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $isTextNode,
  TextNode,
  LexicalEditor,
} from 'lexical';
import { diffCharsOptimized } from '../../../utils/diffAlgorithm';
import { DeletedTextNode, $createDeletedTextNode, $isDeletedTextNode } from '../nodes/DeletedTextNode';
import { extractTextFromLexical, isLexicalJson } from '../../../utils/lexicalUtils';
import { getUserColorIndex, getUserColor } from '../../../utils/userColors';

interface TrackedChange {
  id: string;
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  richTextOldValue?: string;
  richTextNewValue?: string;
}

interface TrackedChangesPluginProps {
  pendingChanges: TrackedChange[];
  originalText: string;
  onChangeClick: (changeId: string) => void;
  liveBaseline?: string;
  currentUserId?: string;
}

// Per-user highlight name prefix for CSS Custom Highlight API
const ADDITION_HIGHLIGHT_PREFIX = 'tracked-addition-';

// Per-change highlight prefix
const CHANGE_HIGHLIGHT_PREFIX = 'tracked-change-';

/**
 * TrackedChangesPlugin manages inline tracked changes in the Lexical editor.
 *
 * - Additions: styled via CSS Custom Highlight API (zero impact on editor state)
 * - Deletions: inserted as DeletedTextNode DecoratorNodes (getTextContent() returns '')
 * - Click handling: deletions via DecoratorNode onClick, additions via editor click handler
 */
export default function TrackedChangesPlugin({
  pendingChanges,
  originalText,
  onChangeClick,
  liveBaseline,
  currentUserId,
}: TrackedChangesPluginProps): null {
  const [editor] = useLexicalComposerContext();
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastCleanTextRef = useRef<string>('');
  const isUpdatingRef = useRef(false);
  const changeIdMapRef = useRef<Map<string, { type: 'addition' | 'deletion'; start: number; end: number }>>(new Map());

  // Listen for tracked-change-click events from DeletedTextNode components
  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const handleTrackedChangeClick = (e: Event) => {
      const customEvent = e as CustomEvent;
      const changeId = customEvent.detail?.changeId;
      if (changeId && !changeId.startsWith('__live__')) {
        onChangeClick(changeId);
      }
    };

    rootElement.addEventListener('tracked-change-click', handleTrackedChangeClick);
    return () => {
      rootElement.removeEventListener('tracked-change-click', handleTrackedChangeClick);
    };
  }, [editor, onChangeClick]);

  // Click handler for additions (CSS Highlight API ranges)
  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const handleClick = (e: MouseEvent) => {
      // Check if click is on a deletion node (handled by its own onClick)
      const target = e.target as HTMLElement;
      if (target.closest('.tracked-deletion')) return;

      // Check if click falls within an addition highlight range
      if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;

      const changeIdMap = changeIdMapRef.current;
      for (const [changeId, info] of changeIdMap) {
        if (info.type !== 'addition') continue;
        // Skip live (unsaved) change IDs — not clickable
        if (changeId.startsWith('__live__')) continue;

        const highlightName = CHANGE_HIGHLIGHT_PREFIX + changeId;
        const highlight = (CSS as any).highlights.get(highlightName);
        if (!highlight) continue;

        // Check if click position is within any of this highlight's ranges
        for (const range of highlight) {
          const rects = range.getClientRects();
          for (const rect of rects) {
            if (
              e.clientX >= rect.left &&
              e.clientX <= rect.right &&
              e.clientY >= rect.top &&
              e.clientY <= rect.bottom
            ) {
              onChangeClick(changeId);
              return;
            }
          }
        }
      }
    };

    rootElement.addEventListener('click', handleClick);
    return () => {
      rootElement.removeEventListener('click', handleClick);
    };
  }, [editor, onChangeClick]);

  // Helper to extract displayable text from content (may be Lexical JSON or plain text)
  const getDisplayableText = useCallback((content: string): string => {
    if (!content) return '';
    if (isLexicalJson(content)) {
      return extractTextFromLexical(content);
    }
    return content;
  }, []);

  // Core decoration logic — per-change character-level diffing
  const applyDecorations = useCallback(() => {
    if (isUpdatingRef.current) return;
    isUpdatingRef.current = true;

    try {
      editor.update(
        () => {
          // Step 1: Remove existing DeletedTextNodes
          const root = $getRoot();
          const deletedNodes: DeletedTextNode[] = [];
          const walkNode = (node: any) => {
            if ($isDeletedTextNode(node)) {
              deletedNodes.push(node);
            }
            if ('getChildren' in node && typeof node.getChildren === 'function') {
              for (const child of node.getChildren()) {
                walkNode(child);
              }
            }
          };
          walkNode(root);

          for (const dn of deletedNodes) {
            dn.remove();
          }

          // Step 2: Build clean text by walking TextNodes directly.
          // This avoids the \n separators that $getRoot().getTextContent() includes
          // between paragraphs, keeping positions aligned with the TextNode walk
          // used by insertDeletedTextNodeAtOffset and the DOM TreeWalker.
          // Also track paragraph boundaries so we can insert \n separators for
          // paragraph-aware diffing while keeping cleanText offset-aligned.
          let cleanText = '';
          const paragraphBoundaries: number[] = [];
          for (const child of root.getChildren()) {
            const startOffset = cleanText.length;
            const collectParaText = (node: any) => {
              if ($isTextNode(node)) {
                cleanText += node.getTextContent();
              }
              if ('getChildren' in node && typeof node.getChildren === 'function') {
                for (const grandchild of node.getChildren()) {
                  if ($isDeletedTextNode(grandchild)) continue;
                  collectParaText(grandchild);
                }
              }
            };
            collectParaText(child);
            // Record boundary for non-empty paragraphs (skip first)
            if (cleanText.length > startOffset && startOffset > 0) {
              paragraphBoundaries.push(startOffset);
            }
          }
          lastCleanTextRef.current = cleanText;

          // Build cleanText with \n between paragraphs for paragraph-aware diffing.
          // extractTextFromLexical joins paragraphs with \n, so liveBaseline has \n.
          // By inserting \n at the same boundaries, the diff sees paragraph structure.
          let cleanTextWithNewlines = '';
          {
            let lastIdx = 0;
            for (const boundary of paragraphBoundaries) {
              cleanTextWithNewlines += cleanText.slice(lastIdx, boundary) + '\n';
              lastIdx = boundary;
            }
            cleanTextWithNewlines += cleanText.slice(lastIdx);
          }

          // Convert offset in cleanTextWithNewlines to offset in cleanText
          // (subtract the number of inserted \n characters before the position)
          const newlinedToClean = (nlOffset: number): number => {
            let nlCount = 0;
            for (const boundary of paragraphBoundaries) {
              if (boundary + nlCount < nlOffset) {
                nlCount++;
              } else {
                break;
              }
            }
            return nlOffset - nlCount;
          };

          if (!cleanText) {
            clearHighlights();
            isUpdatingRef.current = false;
            return;
          }

          const contentChanges = pendingChanges.filter(c => c.field === 'content' && c.status === 'pending');
          if (contentChanges.length === 0 && !liveBaseline) {
            clearHighlights();
            isUpdatingRef.current = false;
            return;
          }

          // Step 3: For each tracked change, diff oldValue vs newValue at char level
          // and map the changed characters to editor positions.
          const normalizeWS = (s: string) => s.replace(/\s+/g, ' ').trim();

          const additionRanges: Array<{ start: number; end: number; changeId: string; colorIndex: number }> = [];
          const deletionInsertions: Array<{
            proposedCharOffset: number;
            changeId: string;
            deletedText: string;
            authorName?: string;
            authorColor?: string;
          }> = [];

          // Ellipsis separator used by backend to join disjoint change segments
          const SEGMENT_SEPARATOR = ' \u2026 ';

          for (const change of contentChanges) {
            // Prefer richText values (full Lexical JSON) when available.
            // The backend's calculateIncrementalChange transforms oldValue/newValue
            // to only contain changed portions, which breaks indexOf-based positioning.
            // richTextOldValue/richTextNewValue contain the full document and
            // produce correct diffs.
            const rawOld = change.richTextOldValue || change.oldValue || '';
            const rawNew = change.richTextNewValue || change.newValue || '';
            // Keep \n between paragraphs for paragraph-aware diffing.
            // getDisplayableText (extractTextFromLexical) joins paragraphs with \n.
            const fullNewDisplay = rawNew ? getDisplayableText(rawNew) : '';
            const fullOldDisplay = rawOld ? getDisplayableText(rawOld) : '';

            if (!fullNewDisplay && !fullOldDisplay) continue;

            // Split by ellipsis separator to handle grouped disjoint changes
            const newSegments = fullNewDisplay.split(SEGMENT_SEPARATOR);
            const oldSegments = fullOldDisplay.split(SEGMENT_SEPARATOR);

            // Process each segment pair independently
            const segCount = Math.max(newSegments.length, oldSegments.length);
            for (let si = 0; si < segCount; si++) {
              const newDisplayText = (newSegments[si] || '').trim();
              const oldDisplayText = (oldSegments[si] || '').trim();

              if (!newDisplayText && !oldDisplayText) continue;

              // Find where the segment's newValue text appears in the editor.
              // Use cleanTextWithNewlines since display text includes \n.
              let newTextStart = cleanTextWithNewlines.indexOf(newDisplayText);
              if (newTextStart === -1) {
                // Fallback: try without newlines (handles plain-text oldValue/newValue)
                const stripped = newDisplayText.replace(/\n/g, '');
                newTextStart = cleanText.indexOf(stripped);
                if (newTextStart !== -1) {
                  // Found in cleanText — use cleanText offsets directly below
                  // (skip newlinedToClean conversion since already in cleanText space)
                  const charDiff = diffCharsOptimized(
                    oldDisplayText.replace(/\n/g, ''), stripped,
                  );
                  let newOffset = 0;
                  const changeColorIndex = getUserColorIndex(change.changedBy || '');
                  const changeColor = getUserColor(change.changedBy || '');
                  for (const seg of charDiff) {
                    if (seg.type === 'equal') {
                      newOffset += seg.value.length;
                    } else if (seg.type === 'insert') {
                      additionRanges.push({
                        start: newTextStart + newOffset,
                        end: newTextStart + newOffset + seg.value.length,
                        changeId: change.id,
                        colorIndex: changeColorIndex,
                      });
                      newOffset += seg.value.length;
                    } else if (seg.type === 'delete') {
                      deletionInsertions.push({
                        proposedCharOffset: newTextStart + newOffset,
                        changeId: change.id,
                        deletedText: seg.value,
                        authorName: change.changedBy,
                        authorColor: changeColor,
                      });
                    }
                  }
                  continue; // Done with this segment
                }
                // Fallback: normalized whitespace match
                const normalizedClean = normalizeWS(cleanText);
                const normalizedNew = normalizeWS(newDisplayText.replace(/\n/g, ''));
                const normPos = normalizedClean.indexOf(normalizedNew);
                if (normPos !== -1) {
                  let rawPos = 0;
                  let normCount = 0;
                  let inWS = false;
                  let started = false;
                  for (let i = 0; i < cleanText.length && normCount < normPos; i++) {
                    if (/\s/.test(cleanText[i])) {
                      if (started && !inWS) { normCount++; inWS = true; }
                    } else {
                      started = true; inWS = false; normCount++;
                    }
                    rawPos = i + 1;
                  }
                  newTextStart = rawPos;
                }
              }

              if (newTextStart === -1) {
                // Context-based fallback for incremental changes whose newDisplayText
                // is an intermediate state that doesn't match the current editor.
                // Diff old vs new to find what this change did, then use surrounding
                // context from newDisplayText to locate each change in the editor.
                const ctxDiff = diffCharsOptimized(
                  oldDisplayText, newDisplayText, { paragraphAligned: true },
                );
                let ctxNewOff = 0;
                const ctxColorIndex = getUserColorIndex(change.changedBy || '');
                const ctxColor = getUserColor(change.changedBy || '');
                const CTX_LEN = 50;
                for (const seg of ctxDiff) {
                  if (seg.type === 'equal') {
                    ctxNewOff += seg.value.length;
                  } else if (seg.type === 'insert') {
                    // Find insertion in current editor using leading context
                    const ctxBefore = newDisplayText.slice(Math.max(0, ctxNewOff - CTX_LEN), ctxNewOff);
                    const needle = ctxBefore + seg.value;
                    const pos = cleanTextWithNewlines.indexOf(needle);
                    if (pos !== -1) {
                      const start = pos + ctxBefore.length;
                      const end = start + seg.value.length;
                      additionRanges.push({
                        start: newlinedToClean(start),
                        end: newlinedToClean(end),
                        changeId: change.id,
                        colorIndex: ctxColorIndex,
                      });
                    }
                    ctxNewOff += seg.value.length;
                  } else if (seg.type === 'delete') {
                    const deleted = seg.value.replace(/^\n+|\n+$/g, '');
                    if (deleted) {
                      // Match surrounding context in current editor to place the ghost
                      const ctxBefore = newDisplayText.slice(Math.max(0, ctxNewOff - CTX_LEN), ctxNewOff);
                      const ctxAfter = newDisplayText.slice(ctxNewOff, Math.min(newDisplayText.length, ctxNewOff + CTX_LEN));
                      let pos = -1;
                      // Try combined context first (before + after deletion point)
                      if (ctxBefore.length > 0 && ctxAfter.length > 0) {
                        pos = cleanTextWithNewlines.indexOf(ctxBefore + ctxAfter);
                        if (pos !== -1) pos += ctxBefore.length;
                      }
                      // Fallback: just leading context
                      if (pos === -1 && ctxBefore.length >= 10) {
                        const p = cleanTextWithNewlines.indexOf(ctxBefore);
                        if (p !== -1) pos = p + ctxBefore.length;
                      }
                      // Fallback: just trailing context
                      if (pos === -1 && ctxAfter.length >= 10) {
                        pos = cleanTextWithNewlines.indexOf(ctxAfter);
                      }
                      if (pos !== -1) {
                        deletionInsertions.push({
                          proposedCharOffset: newlinedToClean(pos),
                          changeId: change.id,
                          deletedText: deleted,
                          authorName: change.changedBy,
                          authorColor: ctxColor,
                        });
                      }
                    }
                    // deletions don't advance ctxNewOff (deleted text is in old, not new)
                  }
                }
                continue;
              }

              // Paragraph-aware character-level diff between old and new segment values
              const charDiff = diffCharsOptimized(
                oldDisplayText, newDisplayText, { paragraphAligned: true },
              );

              // Walk char diff segments and map to editor positions.
              // newTextStart is in cleanTextWithNewlines space, so convert to cleanText.
              let newOffset = 0;
              const changeColorIndex = getUserColorIndex(change.changedBy || '');
              const changeColor = getUserColor(change.changedBy || '');
              for (const seg of charDiff) {
                if (seg.type === 'equal') {
                  newOffset += seg.value.length;
                } else if (seg.type === 'insert') {
                  const cleanStart = newlinedToClean(newTextStart + newOffset);
                  const cleanEnd = newlinedToClean(newTextStart + newOffset + seg.value.length);
                  additionRanges.push({
                    start: cleanStart,
                    end: cleanEnd,
                    changeId: change.id,
                    colorIndex: changeColorIndex,
                  });
                  newOffset += seg.value.length;
                } else if (seg.type === 'delete') {
                  const deletedText = seg.value.replace(/^\n+|\n+$/g, '');
                  if (deletedText) {
                    deletionInsertions.push({
                      proposedCharOffset: newlinedToClean(newTextStart + newOffset),
                      changeId: change.id,
                      deletedText,
                      authorName: change.changedBy,
                      authorColor: changeColor,
                    });
                  }
                }
              }
            }
          }

          // Step 3b: Live diff layer — diff liveBaseline vs current editor text
          // to show unsaved additions/deletions in real-time as the user types.
          // Ranges that overlap with formal-change ranges are skipped.
          // Both liveBaseline and cleanTextWithNewlines use \n between paragraphs,
          // and we pass paragraphAligned to diffCharsOptimized so the prefix/suffix
          // matching snaps to paragraph boundaries instead of bleeding across them.
          if (liveBaseline) {
            if (liveBaseline && cleanTextWithNewlines !== liveBaseline) {
              // Build a set of character positions already covered by formal changes
              const coveredPositions = new Set<number>();
              for (const ar of additionRanges) {
                for (let i = ar.start; i < ar.end; i++) coveredPositions.add(i);
              }
              for (const di of deletionInsertions) {
                coveredPositions.add(di.proposedCharOffset);
              }

              const liveDiff = diffCharsOptimized(
                liveBaseline, cleanTextWithNewlines, { paragraphAligned: true },
              );
              let newOff = 0; // offset in cleanTextWithNewlines (the "new" side)
              for (const seg of liveDiff) {
                if (seg.type === 'equal') {
                  newOff += seg.value.length;
                } else if (seg.type === 'insert') {
                  const cleanStart = newlinedToClean(newOff);
                  const cleanEnd = newlinedToClean(newOff + seg.value.length);
                  let overlaps = false;
                  for (let i = cleanStart; i < cleanEnd; i++) {
                    if (coveredPositions.has(i)) { overlaps = true; break; }
                  }
                  if (!overlaps) {
                    additionRanges.push({
                      start: cleanStart,
                      end: cleanEnd,
                      changeId: '__live__addition',
                      colorIndex: currentUserId ? getUserColorIndex(currentUserId) : 0,
                    });
                  }
                  newOff += seg.value.length;
                } else if (seg.type === 'delete') {
                  const cleanOffset = newlinedToClean(newOff);
                  if (!coveredPositions.has(cleanOffset)) {
                    // seg.value already includes \n from liveBaseline;
                    // trim leading/trailing \n to avoid blank lines at edges.
                    const deletedText = seg.value.replace(/^\n+|\n+$/g, '');
                    if (deletedText) {
                      deletionInsertions.push({
                        proposedCharOffset: cleanOffset,
                        changeId: '__live__deletion',
                        deletedText,
                        authorColor: currentUserId ? getUserColor(currentUserId) : undefined,
                      });
                    }
                  }
                  // Deletions don't advance newOff
                }
              }
            }
          }

          // Step 4: Insert DeletedTextNodes in REVERSE offset order
          const sortedDeletions = [...deletionInsertions].sort(
            (a, b) => b.proposedCharOffset - a.proposedCharOffset
          );

          for (const deletion of sortedDeletions) {
            insertDeletedTextNodeAtOffset(
              deletion.proposedCharOffset,
              deletion.changeId,
              deletion.deletedText,
              deletion.authorName,
              deletion.authorColor,
              paragraphBoundaries,
            );
          }

          // Step 5: Update the change ID map for click handling
          const newChangeIdMap = new Map<string, { type: 'addition' | 'deletion'; start: number; end: number }>();
          for (const addition of additionRanges) {
            const existing = newChangeIdMap.get(addition.changeId);
            if (existing && existing.type === 'addition') {
              existing.start = Math.min(existing.start, addition.start);
              existing.end = Math.max(existing.end, addition.end);
            } else {
              newChangeIdMap.set(addition.changeId, { type: 'addition', start: addition.start, end: addition.end });
            }
          }
          for (const deletion of deletionInsertions) {
            if (!newChangeIdMap.has(deletion.changeId)) {
              newChangeIdMap.set(deletion.changeId, { type: 'deletion', start: deletion.proposedCharOffset, end: deletion.proposedCharOffset });
            }
          }
          changeIdMapRef.current = newChangeIdMap;

          // Step 6: Schedule highlight application and spellcheck suppression
          // after DOM reconciliation
          requestAnimationFrame(() => {
            applyAdditionHighlights(editor, additionRanges);
            suppressSpellcheckNearDeletions(editor);
            isUpdatingRef.current = false;
          });
        },
        { tag: 'historic' }
      );
    } catch (err) {
      console.error('TrackedChangesPlugin: error applying decorations', err);
      isUpdatingRef.current = false;
    }
  }, [editor, originalText, pendingChanges, getDisplayableText, liveBaseline, currentUserId]);

  // Debounced update on editor changes
  useEffect(() => {
    const unregister = editor.registerUpdateListener(() => {
      // Skip our own decoration updates (tagged 'historic' to avoid polluting undo)
      if (isUpdatingRef.current) return;

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        applyDecorations();
      }, 100);
    });
    return () => {
      unregister();
      // Cancel pending debounced invocation so stale closures don't fire
      // after applyDecorations is recreated with updated pendingChanges
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [editor, applyDecorations]);

  // Re-apply when pendingChanges or originalText change
  useEffect(() => {
    // Small delay to let the editor settle
    const timer = setTimeout(() => {
      applyDecorations();
    }, 150);
    return () => clearTimeout(timer);
  }, [pendingChanges, originalText, applyDecorations]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      clearHighlights();
    };
  }, []);

  return null;
}

/**
 * Insert a DeletedTextNode at a given character offset in the proposed text.
 * Must be called within an editor.update() callback.
 */
function insertDeletedTextNodeAtOffset(
  charOffset: number,
  changeId: string,
  deletedText: string,
  authorName?: string,
  authorColor?: string,
  paragraphBoundaries?: number[],
): void {
  const root = $getRoot();
  let cumulativeOffset = 0;

  // Walk all text nodes in document order
  const textNodes: TextNode[] = [];
  const collectTextNodes = (node: any) => {
    if ($isTextNode(node)) {
      textNodes.push(node);
    }
    if ('getChildren' in node && typeof node.getChildren === 'function') {
      for (const child of node.getChildren()) {
        // Skip DeletedTextNodes — they don't contribute to offset
        if ($isDeletedTextNode(child)) continue;
        collectTextNodes(child);
      }
    }
  };
  collectTextNodes(root);

  for (const textNode of textNodes) {
    const nodeTextLength = textNode.getTextContentSize();
    const nodeStart = cumulativeOffset;
    const nodeEnd = cumulativeOffset + nodeTextLength;

    if (charOffset >= nodeStart && charOffset < nodeEnd) {
      const localOffset = charOffset - nodeStart;
      if (localOffset === 0) {
        // Check if this offset is a paragraph boundary — the deleted text
        // likely came from a paragraph that was removed or emptied.
        // If a preceding empty paragraph exists (Lexical leaves these behind
        // when the user deletes a line's text), insert the ghost there so it
        // stays on its own line instead of merging inline with the next paragraph.
        const isAtParagraphBoundary = paragraphBoundaries?.includes(charOffset) || charOffset === 0;
        if (isAtParagraphBoundary) {
          // Paragraph-level deletion: insert as block-level element before
          // the text node so it renders on its own line above the next content.
          const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor, isBlockLevel: true });
          textNode.insertBefore(deletedNode);
        } else {
          // Inline deletion: insert before this text node
          const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor });
          textNode.insertBefore(deletedNode);
        }
      } else if (localOffset >= nodeTextLength) {
        // Insert after this text node
        const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor });
        textNode.insertAfter(deletedNode);
      } else {
        // Split the text node and insert between
        const [_left] = textNode.splitText(localOffset);
        const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor });
        _left.insertAfter(deletedNode);
      }
      return;
    }

    cumulativeOffset = nodeEnd;
  }

  // If offset is at or beyond end, append to last text node
  if (textNodes.length > 0) {
    const lastNode = textNodes[textNodes.length - 1];
    const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor });
    lastNode.insertAfter(deletedNode);
  }
}

/**
 * After DOM reconciliation, suppress spellcheck on Lexical text spans
 * adjacent to tracked deletion markers. When a word like "Despotism" has
 * its "D" shown as a deleted ghost, the remaining fragments "d" and "espotism"
 * would be flagged by the browser spellchecker. Setting spellcheck=false on
 * those sibling spans prevents the red underlines.
 */
function suppressSpellcheckNearDeletions(editor: LexicalEditor): void {
  const rootElement = editor.getRootElement();
  if (!rootElement) return;

  // First, reset any previously suppressed spans
  rootElement.querySelectorAll('[data-spellcheck-suppressed]').forEach((el) => {
    el.removeAttribute('spellcheck');
    el.removeAttribute('data-spellcheck-suppressed');
  });

  // For each tracked deletion wrapper, suppress spellcheck on adjacent text spans
  rootElement.querySelectorAll('.tracked-deletion-wrapper').forEach((wrapper) => {
    const prev = wrapper.previousElementSibling;
    const next = wrapper.nextElementSibling;

    if (prev && prev.hasAttribute('data-lexical-text')) {
      prev.setAttribute('spellcheck', 'false');
      prev.setAttribute('data-spellcheck-suppressed', 'true');
    }
    if (next && next.hasAttribute('data-lexical-text')) {
      next.setAttribute('spellcheck', 'false');
      next.setAttribute('data-spellcheck-suppressed', 'true');
    }
  });
}

/**
 * Apply CSS Custom Highlight API ranges for addition segments.
 * Called after DOM reconciliation (in requestAnimationFrame).
 * Groups ranges by colorIndex so each user's additions get their own highlight color.
 */
function applyAdditionHighlights(
  editor: LexicalEditor,
  additionRanges: Array<{ start: number; end: number; changeId: string; colorIndex: number }>,
): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;

  // Clear existing highlights
  clearHighlights();

  if (additionRanges.length === 0) return;

  const rootElement = editor.getRootElement();
  if (!rootElement) return;

  // Walk DOM text nodes (skipping .tracked-deletion spans)
  const domTextNodes: Array<{ node: Text; cumStart: number; cumEnd: number }> = [];
  let cumOffset = 0;

  const walker = document.createTreeWalker(
    rootElement,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node: Node) => {
        // Skip text nodes inside tracked-deletion spans
        const parent = node.parentElement;
        if (parent?.closest('.tracked-deletion')) {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip text nodes inside tracked-deletion-wrapper spans
        if (parent?.closest('.tracked-deletion-wrapper')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let current: Text | null;
  while ((current = walker.nextNode() as Text | null)) {
    const length = current.textContent?.length || 0;
    domTextNodes.push({
      node: current,
      cumStart: cumOffset,
      cumEnd: cumOffset + length,
    });
    cumOffset += length;
  }

  if (domTextNodes.length === 0) return;

  // Group ranges by colorIndex for per-user highlight colors
  const perColorRanges = new Map<number, Range[]>();
  const perChangeRanges = new Map<string, Range[]>();

  for (const addition of additionRanges) {
    const ranges = createDOMRangesForCharRange(domTextNodes, addition.start, addition.end);

    // Accumulate by color index
    if (!perColorRanges.has(addition.colorIndex)) {
      perColorRanges.set(addition.colorIndex, []);
    }
    perColorRanges.get(addition.colorIndex)!.push(...ranges);

    // Accumulate per-change for click detection
    if (!perChangeRanges.has(addition.changeId)) {
      perChangeRanges.set(addition.changeId, []);
    }
    perChangeRanges.get(addition.changeId)!.push(...ranges);
  }

  // Apply per-color highlights for styling (tracked-addition-0 … tracked-addition-9)
  for (const [colorIndex, ranges] of perColorRanges) {
    if (ranges.length > 0) {
      try {
        const highlight = new (window as any).Highlight(...ranges);
        (CSS as any).highlights.set(ADDITION_HIGHLIGHT_PREFIX + colorIndex, highlight);
      } catch (err) {
        // Graceful fallback: CSS Highlight API not supported
      }
    }
  }

  // Apply per-change highlights for click detection
  for (const [changeId, ranges] of perChangeRanges) {
    if (ranges.length > 0) {
      try {
        const highlight = new (window as any).Highlight(...ranges);
        (CSS as any).highlights.set(CHANGE_HIGHLIGHT_PREFIX + changeId, highlight);
      } catch (err) {
        // Graceful fallback
      }
    }
  }
}

/**
 * Create DOM Range objects for a character range [start, end) in the text content.
 */
function createDOMRangesForCharRange(
  domTextNodes: Array<{ node: Text; cumStart: number; cumEnd: number }>,
  start: number,
  end: number,
): Range[] {
  const ranges: Range[] = [];

  for (const entry of domTextNodes) {
    // Check if this text node overlaps with [start, end)
    if (entry.cumEnd <= start || entry.cumStart >= end) continue;

    const rangeStart = Math.max(0, start - entry.cumStart);
    const rangeEnd = Math.min(entry.node.textContent?.length || 0, end - entry.cumStart);

    if (rangeStart >= rangeEnd) continue;

    try {
      const range = document.createRange();
      range.setStart(entry.node, rangeStart);
      range.setEnd(entry.node, rangeEnd);
      ranges.push(range);
    } catch (err) {
      // Skip invalid ranges
    }
  }

  return ranges;
}

/**
 * Clear all tracked change highlights.
 */
function clearHighlights(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;

  try {
    // Clear per-color addition highlights and per-change highlights
    const keysToDelete: string[] = [];
    (CSS as any).highlights.forEach((_: any, key: string) => {
      if (key.startsWith(ADDITION_HIGHLIGHT_PREFIX) || key.startsWith(CHANGE_HIGHLIGHT_PREFIX)) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      (CSS as any).highlights.delete(key);
    }
  } catch (err) {
    // Graceful fallback
  }
}
