import { useEffect, useRef, useCallback } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $isTextNode,
  TextNode,
  LexicalEditor,
  NodeKey,
} from 'lexical';
import { diffCharsOptimized } from '../../../utils/diffAlgorithm';
import { DeletedTextNode, $createDeletedTextNode, $isDeletedTextNode } from '../nodes/DeletedTextNode';
import { extractTextFromLexical, isLexicalJson } from '../../../utils/lexicalUtils';
import { getUserColorIndex, getUserColor } from '../../../utils/userColors';

export interface TrackedChange {
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

// ---- Types for incremental decoration state ----

/** Describes the addition highlight ranges associated with a single change. */
interface ChangeHighlightRecord {
  colorIndex: number;
  /** Character ranges in cleanText space. DOM Range objects are ephemeral and
   *  rebuilt after each DOM reconciliation, so we store logical ranges here. */
  charRanges: Array<{ start: number; end: number }>;
}

/** Describes the DeletedTextNode(s) inserted for a single change. */
interface ChangeDeletionRecord {
  /** Lexical node keys for the DeletedTextNodes we inserted. */
  nodeKeys: NodeKey[];
  /** The deletion specs, kept for potential re-insertion after DOM changes. */
  specs: Array<{
    proposedCharOffset: number;
    deletedText: string;
    authorName?: string;
    authorColor?: string;
  }>;
}

// ---- Singleton decoration registry (module-level for public API access) ----

/** Map of changeId -> highlight records for additions. */
const highlightRegistry = new Map<string, ChangeHighlightRecord>();

/** Map of changeId -> deletion records for DeletedTextNodes. */
const deletionRegistry = new Map<string, ChangeDeletionRecord>();

/** Reference to the active editor instance (set by the plugin). */
let activeEditorRef: LexicalEditor | null = null;

// ---- Public API ----

/**
 * Remove all decorations (highlights + DeletedTextNodes) for a specific changeId.
 * Used by TransactionHistoryPlugin and cascade rejection.
 */
export function removeDecorationsForChange(changeId: string): void {
  // Remove CSS highlights for this change
  removeHighlightsForChange(changeId);
  highlightRegistry.delete(changeId);

  // Remove DeletedTextNodes for this change
  const deletionRecord = deletionRegistry.get(changeId);
  if (deletionRecord && activeEditorRef) {
    const editor = activeEditorRef;
    editor.update(
      () => {
        for (const nodeKey of deletionRecord.nodeKeys) {
          const root = $getRoot();
          const node = findNodeByKey(root, nodeKey);
          if (node && $isDeletedTextNode(node)) {
            node.remove();
          }
        }
      },
      { tag: 'historic' }
    );
  }
  deletionRegistry.delete(changeId);
}

/**
 * Remove decorations for a change with a fade-out animation (for acceptance).
 * Fades opacity over 200ms, then collapses height over 200ms, then removes nodes.
 */
export function removeDecorationsForChangeAnimated(changeId: string): Promise<void> {
  return new Promise((resolve) => {
    // Remove CSS highlights immediately (they don't animate)
    removeHighlightsForChange(changeId);
    highlightRegistry.delete(changeId);

    const deletionRecord = deletionRegistry.get(changeId);
    if (!deletionRecord || !activeEditorRef) {
      deletionRegistry.delete(changeId);
      resolve();
      return;
    }

    const editor = activeEditorRef;
    const rootElement = editor.getRootElement();
    if (!rootElement) {
      deletionRegistry.delete(changeId);
      resolve();
      return;
    }

    // Find DOM elements for this change's DeletedTextNodes
    const wrappers = rootElement.querySelectorAll(
      `.tracked-deletion-wrapper[data-change-id="${changeId}"]`
    );

    if (wrappers.length === 0) {
      // No DOM elements — just remove from registry and editor state
      removeDecorationsForChange(changeId);
      resolve();
      return;
    }

    // Phase 1: Fade out opacity (200ms)
    wrappers.forEach((wrapper) => {
      const el = wrapper as HTMLElement;
      el.style.transition = 'opacity 200ms ease-out';
      el.style.opacity = '0';
    });

    setTimeout(() => {
      // Phase 2: Collapse height (200ms)
      wrappers.forEach((wrapper) => {
        const el = wrapper as HTMLElement;
        el.style.transition = 'max-height 200ms ease-out, margin 200ms ease-out, padding 200ms ease-out';
        el.style.overflow = 'hidden';
        el.style.maxHeight = '0';
        el.style.margin = '0';
        el.style.padding = '0';
      });

      setTimeout(() => {
        // Phase 3: Remove from editor state
        editor.update(
          () => {
            for (const nodeKey of deletionRecord.nodeKeys) {
              const root = $getRoot();
              const node = findNodeByKey(root, nodeKey);
              if (node && $isDeletedTextNode(node)) {
                node.remove();
              }
            }
          },
          { tag: 'historic' }
        );
        deletionRegistry.delete(changeId);
        resolve();
      }, 200);
    }, 200);
  });
}

/**
 * Add decorations for a specific change. Used when receiving WebSocket events
 * for changes made by other users.
 */
export function addDecorationsForChange(
  change: TrackedChange,
  editor: LexicalEditor,
): void {
  // This triggers a full re-diff for just this one change, inserting it
  // into the registry and the editor. We delegate to the internal logic.
  if (!editor) return;
  applyDecorationsForSingleChange(editor, change);
}

/**
 * Get the set of change IDs that currently have decorations applied.
 */
export function getDecoratedChangeIds(): Set<string> {
  const ids = new Set<string>();
  for (const id of highlightRegistry.keys()) ids.add(id);
  for (const id of deletionRegistry.keys()) ids.add(id);
  return ids;
}

// ---- Helper to find a Lexical node by key in the tree ----

function findNodeByKey(root: any, key: NodeKey): any {
  if (root.__key === key) return root;
  if ('getChildren' in root && typeof root.getChildren === 'function') {
    for (const child of root.getChildren()) {
      const found = findNodeByKey(child, key);
      if (found) return found;
    }
  }
  return null;
}

// ---- Plugin component ----

/**
 * TrackedChangesPlugin manages inline tracked changes in the Lexical editor.
 *
 * Refactored for incremental decoration rendering:
 * - Additions: styled via CSS Custom Highlight API (zero DOM impact)
 * - Deletions: inserted as DeletedTextNode DecoratorNodes (getTextContent() returns '')
 * - Decorations are applied incrementally: only NEW changes get decorations,
 *   existing decorations are left untouched (no strip-and-rebuild).
 * - When a change is removed, only THAT change's decorations are cleaned up.
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
  // Track which change IDs were decorated in the previous render cycle
  const previousChangeIdsRef = useRef<Set<string>>(new Set());
  // Track the previous liveBaseline to detect changes
  const previousLiveBaselineRef = useRef<string | undefined>(undefined);

  // Register this editor as the active one for public API
  useEffect(() => {
    activeEditorRef = editor;
    return () => {
      if (activeEditorRef === editor) {
        activeEditorRef = null;
      }
    };
  }, [editor]);

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

  // Core incremental decoration logic
  const applyDecorations = useCallback(() => {
    if (isUpdatingRef.current) return;
    isUpdatingRef.current = true;

    try {
      editor.update(
        () => {
          const root = $getRoot();

          // Determine which formal change IDs are currently active
          const contentChanges = pendingChanges.filter(c => c.field === 'content' && c.status === 'pending');
          const currentChangeIds = new Set(contentChanges.map(c => c.id));

          // Add special IDs for live baseline changes
          const hasLiveBaseline = !!liveBaseline;
          if (hasLiveBaseline) {
            currentChangeIds.add('__live__addition');
            currentChangeIds.add('__live__deletion');
          }

          // Determine which change IDs are NEW (not yet decorated)
          const previousIds = previousChangeIdsRef.current;
          const newChangeIds = new Set<string>();
          const removedChangeIds = new Set<string>();

          for (const id of currentChangeIds) {
            if (!previousIds.has(id)) {
              newChangeIds.add(id);
            }
          }
          for (const id of previousIds) {
            if (!currentChangeIds.has(id)) {
              removedChangeIds.add(id);
            }
          }

          // Live baseline changes are always re-computed (they change on every keystroke)
          const liveBaselineChanged = liveBaseline !== previousLiveBaselineRef.current;
          const mustRefreshLive = liveBaselineChanged || hasLiveBaseline;
          if (mustRefreshLive) {
            // Always recompute live decorations
            newChangeIds.add('__live__addition');
            newChangeIds.add('__live__deletion');
          }

          // Step 1: Remove decorations for changes that are no longer present
          for (const removedId of removedChangeIds) {
            // Remove DeletedTextNodes for this change
            const deletionRecord = deletionRegistry.get(removedId);
            if (deletionRecord) {
              for (const nodeKey of deletionRecord.nodeKeys) {
                const node = findNodeByKey(root, nodeKey);
                if (node && $isDeletedTextNode(node)) {
                  node.remove();
                }
              }
              deletionRegistry.delete(removedId);
            }
            // Remove highlights
            removeHighlightsForChange(removedId);
            highlightRegistry.delete(removedId);
          }

          // Also remove live decorations if we're refreshing them
          if (mustRefreshLive) {
            for (const liveId of ['__live__addition', '__live__deletion']) {
              const deletionRecord = deletionRegistry.get(liveId);
              if (deletionRecord) {
                for (const nodeKey of deletionRecord.nodeKeys) {
                  const node = findNodeByKey(root, nodeKey);
                  if (node && $isDeletedTextNode(node)) {
                    node.remove();
                  }
                }
                deletionRegistry.delete(liveId);
              }
              removeHighlightsForChange(liveId);
              highlightRegistry.delete(liveId);
            }
          }

          // If no new changes and no removals and no live refresh needed, we still
          // need to rebuild highlights after editor text changes (DOM reconciliation
          // invalidates Range objects). But we can skip the diffing step for
          // already-decorated formal changes and just recompute DOM ranges from
          // the stored charRanges.
          const needsNewDiff = newChangeIds.size > 0 || removedChangeIds.size > 0;

          // Step 2: Build clean text (excluding DeletedTextNodes)
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
            if (cleanText.length > startOffset && startOffset > 0) {
              paragraphBoundaries.push(startOffset);
            }
          }
          lastCleanTextRef.current = cleanText;

          // Build cleanText with \n between paragraphs for paragraph-aware diffing
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
            clearAllDecorations();
            previousChangeIdsRef.current = new Set();
            previousLiveBaselineRef.current = liveBaseline;
            isUpdatingRef.current = false;
            return;
          }

          if (contentChanges.length === 0 && !liveBaseline) {
            clearAllDecorations();
            previousChangeIdsRef.current = new Set();
            previousLiveBaselineRef.current = liveBaseline;
            isUpdatingRef.current = false;
            return;
          }

          // Step 3: Compute additions/deletions ONLY for new changes
          const normalizeWS = (s: string) => s.replace(/\s+/g, ' ').trim();
          const SEGMENT_SEPARATOR = ' \u2026 ';

          const newAdditionRanges: Array<{ start: number; end: number; changeId: string; colorIndex: number }> = [];
          const newDeletionInsertions: Array<{
            proposedCharOffset: number;
            changeId: string;
            deletedText: string;
            authorName?: string;
            authorColor?: string;
          }> = [];

          // Only diff changes that need new decorations
          const changesToProcess = contentChanges.filter(c => newChangeIds.has(c.id));

          for (const change of changesToProcess) {
            const rawOld = change.richTextOldValue || change.oldValue || '';
            const rawNew = change.richTextNewValue || change.newValue || '';
            const fullNewDisplay = rawNew ? getDisplayableText(rawNew) : '';
            const fullOldDisplay = rawOld ? getDisplayableText(rawOld) : '';

            if (!fullNewDisplay && !fullOldDisplay) continue;

            const newSegments = fullNewDisplay.split(SEGMENT_SEPARATOR);
            const oldSegments = fullOldDisplay.split(SEGMENT_SEPARATOR);

            const segCount = Math.max(newSegments.length, oldSegments.length);
            for (let si = 0; si < segCount; si++) {
              const newDisplayText = (newSegments[si] || '').trim();
              const oldDisplayText = (oldSegments[si] || '').trim();

              if (!newDisplayText && !oldDisplayText) continue;

              let newTextStart = cleanTextWithNewlines.indexOf(newDisplayText);
              if (newTextStart === -1) {
                const stripped = newDisplayText.replace(/\n/g, '');
                newTextStart = cleanText.indexOf(stripped);
                if (newTextStart !== -1) {
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
                      newAdditionRanges.push({
                        start: newTextStart + newOffset,
                        end: newTextStart + newOffset + seg.value.length,
                        changeId: change.id,
                        colorIndex: changeColorIndex,
                      });
                      newOffset += seg.value.length;
                    } else if (seg.type === 'delete') {
                      newDeletionInsertions.push({
                        proposedCharOffset: newTextStart + newOffset,
                        changeId: change.id,
                        deletedText: seg.value,
                        authorName: change.changedBy,
                        authorColor: changeColor,
                      });
                    }
                  }
                  continue;
                }
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
                    const ctxBefore = newDisplayText.slice(Math.max(0, ctxNewOff - CTX_LEN), ctxNewOff);
                    const needle = ctxBefore + seg.value;
                    const pos = cleanTextWithNewlines.indexOf(needle);
                    if (pos !== -1) {
                      const start = pos + ctxBefore.length;
                      const end = start + seg.value.length;
                      newAdditionRanges.push({
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
                      const ctxBefore = newDisplayText.slice(Math.max(0, ctxNewOff - CTX_LEN), ctxNewOff);
                      const ctxAfter = newDisplayText.slice(ctxNewOff, Math.min(newDisplayText.length, ctxNewOff + CTX_LEN));
                      let pos = -1;
                      if (ctxBefore.length > 0 && ctxAfter.length > 0) {
                        pos = cleanTextWithNewlines.indexOf(ctxBefore + ctxAfter);
                        if (pos !== -1) pos += ctxBefore.length;
                      }
                      if (pos === -1 && ctxBefore.length >= 10) {
                        const p = cleanTextWithNewlines.indexOf(ctxBefore);
                        if (p !== -1) pos = p + ctxBefore.length;
                      }
                      if (pos === -1 && ctxAfter.length >= 10) {
                        pos = cleanTextWithNewlines.indexOf(ctxAfter);
                      }
                      if (pos !== -1) {
                        newDeletionInsertions.push({
                          proposedCharOffset: newlinedToClean(pos),
                          changeId: change.id,
                          deletedText: deleted,
                          authorName: change.changedBy,
                          authorColor: ctxColor,
                        });
                      }
                    }
                  }
                }
                continue;
              }

              const charDiff = diffCharsOptimized(
                oldDisplayText, newDisplayText, { paragraphAligned: true },
              );

              let newOffset = 0;
              const changeColorIndex = getUserColorIndex(change.changedBy || '');
              const changeColor = getUserColor(change.changedBy || '');
              for (const seg of charDiff) {
                if (seg.type === 'equal') {
                  newOffset += seg.value.length;
                } else if (seg.type === 'insert') {
                  const cleanStart = newlinedToClean(newTextStart + newOffset);
                  const cleanEnd = newlinedToClean(newTextStart + newOffset + seg.value.length);
                  newAdditionRanges.push({
                    start: cleanStart,
                    end: cleanEnd,
                    changeId: change.id,
                    colorIndex: changeColorIndex,
                  });
                  newOffset += seg.value.length;
                } else if (seg.type === 'delete') {
                  const deletedText = seg.value.replace(/^\n+|\n+$/g, '');
                  if (deletedText) {
                    newDeletionInsertions.push({
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

          // Step 3b: Live diff layer (always recomputed when liveBaseline is present)
          if (mustRefreshLive && liveBaseline && cleanTextWithNewlines !== liveBaseline) {
            // Build a set of character positions covered by ALL formal changes
            // (both existing and newly added)
            const coveredPositions = new Set<number>();
            // From existing registry
            for (const [cid, record] of highlightRegistry) {
              if (cid.startsWith('__live__')) continue;
              for (const cr of record.charRanges) {
                for (let i = cr.start; i < cr.end; i++) coveredPositions.add(i);
              }
            }
            // From newly computed addition ranges
            for (const ar of newAdditionRanges) {
              if (ar.changeId.startsWith('__live__')) continue;
              for (let i = ar.start; i < ar.end; i++) coveredPositions.add(i);
            }
            // From existing deletion registry
            for (const [cid, record] of deletionRegistry) {
              if (cid.startsWith('__live__')) continue;
              for (const spec of record.specs) {
                coveredPositions.add(spec.proposedCharOffset);
              }
            }
            // From newly computed deletions
            for (const di of newDeletionInsertions) {
              if (di.changeId.startsWith('__live__')) continue;
              coveredPositions.add(di.proposedCharOffset);
            }

            const liveDiff = diffCharsOptimized(
              liveBaseline, cleanTextWithNewlines, { paragraphAligned: true },
            );
            let newOff = 0;
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
                  newAdditionRanges.push({
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
                  const deletedText = seg.value.replace(/^\n+|\n+$/g, '');
                  if (deletedText) {
                    newDeletionInsertions.push({
                      proposedCharOffset: cleanOffset,
                      changeId: '__live__deletion',
                      deletedText,
                      authorColor: currentUserId ? getUserColor(currentUserId) : undefined,
                    });
                  }
                }
              }
            }
          }

          // Step 4: Insert new DeletedTextNodes in REVERSE offset order
          const sortedDeletions = [...newDeletionInsertions].sort(
            (a, b) => b.proposedCharOffset - a.proposedCharOffset
          );

          for (const deletion of sortedDeletions) {
            const nodeKey = insertDeletedTextNodeAtOffset(
              deletion.proposedCharOffset,
              deletion.changeId,
              deletion.deletedText,
              deletion.authorName,
              deletion.authorColor,
              paragraphBoundaries,
            );

            // Register in deletion registry
            if (nodeKey) {
              let record = deletionRegistry.get(deletion.changeId);
              if (!record) {
                record = { nodeKeys: [], specs: [] };
                deletionRegistry.set(deletion.changeId, record);
              }
              record.nodeKeys.push(nodeKey);
              record.specs.push({
                proposedCharOffset: deletion.proposedCharOffset,
                deletedText: deletion.deletedText,
                authorName: deletion.authorName,
                authorColor: deletion.authorColor,
              });
            }
          }

          // Step 5: Register new highlight records
          for (const addition of newAdditionRanges) {
            let record = highlightRegistry.get(addition.changeId);
            if (!record) {
              record = { colorIndex: addition.colorIndex, charRanges: [] };
              highlightRegistry.set(addition.changeId, record);
            }
            record.charRanges.push({ start: addition.start, end: addition.end });
          }

          // Step 6: Update the change ID map for click handling
          // Merge existing registry entries with new ones
          const newChangeIdMap = new Map<string, { type: 'addition' | 'deletion'; start: number; end: number }>();
          for (const [cid, record] of highlightRegistry) {
            for (const cr of record.charRanges) {
              const existing = newChangeIdMap.get(cid);
              if (existing && existing.type === 'addition') {
                existing.start = Math.min(existing.start, cr.start);
                existing.end = Math.max(existing.end, cr.end);
              } else {
                newChangeIdMap.set(cid, { type: 'addition', start: cr.start, end: cr.end });
              }
            }
          }
          for (const [cid, record] of deletionRegistry) {
            if (!newChangeIdMap.has(cid)) {
              const firstSpec = record.specs[0];
              if (firstSpec) {
                newChangeIdMap.set(cid, { type: 'deletion', start: firstSpec.proposedCharOffset, end: firstSpec.proposedCharOffset });
              }
            }
          }
          changeIdMapRef.current = newChangeIdMap;

          // Update previous state tracking
          previousChangeIdsRef.current = currentChangeIds;
          previousLiveBaselineRef.current = liveBaseline;

          // Step 7: Schedule highlight application and spellcheck suppression
          // ALL highlights must be rebuilt on every update because DOM reconciliation
          // invalidates Range objects. But this is cheap (no editor state mutation).
          requestAnimationFrame(() => {
            rebuildAllHighlightsFromRegistry(editor);
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
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [editor, applyDecorations]);

  // Re-apply when pendingChanges or originalText change
  useEffect(() => {
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
      clearAllDecorations();
    };
  }, []);

  return null;
}

/**
 * Insert a DeletedTextNode at a given character offset in the proposed text.
 * Must be called within an editor.update() callback.
 * Returns the Lexical node key of the inserted node, or null if insertion failed.
 */
function insertDeletedTextNodeAtOffset(
  charOffset: number,
  changeId: string,
  deletedText: string,
  authorName?: string,
  authorColor?: string,
  paragraphBoundaries?: number[],
): NodeKey | null {
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
        const isAtParagraphBoundary = paragraphBoundaries?.includes(charOffset) || charOffset === 0;
        if (isAtParagraphBoundary) {
          const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor, isBlockLevel: true });
          textNode.insertBefore(deletedNode);
          return deletedNode.getKey();
        } else {
          const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor });
          textNode.insertBefore(deletedNode);
          return deletedNode.getKey();
        }
      } else if (localOffset >= nodeTextLength) {
        const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor });
        textNode.insertAfter(deletedNode);
        return deletedNode.getKey();
      } else {
        const [_left] = textNode.splitText(localOffset);
        const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor });
        _left.insertAfter(deletedNode);
        return deletedNode.getKey();
      }
    }

    cumulativeOffset = nodeEnd;
  }

  // If offset is at or beyond end, append to last text node
  if (textNodes.length > 0) {
    const lastNode = textNodes[textNodes.length - 1];
    const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor });
    lastNode.insertAfter(deletedNode);
    return deletedNode.getKey();
  }

  return null;
}

/**
 * After DOM reconciliation, suppress spellcheck on Lexical text spans
 * adjacent to tracked deletion markers.
 */
function suppressSpellcheckNearDeletions(editor: LexicalEditor): void {
  const rootElement = editor.getRootElement();
  if (!rootElement) return;

  rootElement.querySelectorAll('[data-spellcheck-suppressed]').forEach((el) => {
    el.removeAttribute('spellcheck');
    el.removeAttribute('data-spellcheck-suppressed');
  });

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
 * Rebuild all CSS Custom Highlight API ranges from the registry.
 * Called after every DOM reconciliation because Range objects become invalid.
 * This is a DOM-only operation — no editor state mutation.
 */
function rebuildAllHighlightsFromRegistry(editor: LexicalEditor): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;

  // Clear all existing tracked highlights
  clearHighlights();

  if (highlightRegistry.size === 0) return;

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
        const parent = node.parentElement;
        if (parent?.closest('.tracked-deletion')) {
          return NodeFilter.FILTER_REJECT;
        }
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

  for (const [changeId, record] of highlightRegistry) {
    for (const charRange of record.charRanges) {
      const ranges = createDOMRangesForCharRange(domTextNodes, charRange.start, charRange.end);

      // Accumulate by color index
      if (!perColorRanges.has(record.colorIndex)) {
        perColorRanges.set(record.colorIndex, []);
      }
      perColorRanges.get(record.colorIndex)!.push(...ranges);

      // Accumulate per-change for click detection
      if (!perChangeRanges.has(changeId)) {
        perChangeRanges.set(changeId, []);
      }
      perChangeRanges.get(changeId)!.push(...ranges);
    }
  }

  // Apply per-color highlights for styling
  for (const [colorIndex, ranges] of perColorRanges) {
    if (ranges.length > 0) {
      try {
        const highlight = new (window as any).Highlight(...ranges);
        (CSS as any).highlights.set(ADDITION_HIGHLIGHT_PREFIX + colorIndex, highlight);
      } catch (err) {
        // Graceful fallback
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
 * Remove CSS highlights for a specific changeId.
 */
function removeHighlightsForChange(changeId: string): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;

  try {
    // Remove the per-change highlight
    const changeKey = CHANGE_HIGHLIGHT_PREFIX + changeId;
    if ((CSS as any).highlights.has(changeKey)) {
      (CSS as any).highlights.delete(changeKey);
    }

    // We don't remove per-color highlights here because they aggregate
    // across all changes with the same color. They will be rebuilt by
    // rebuildAllHighlightsFromRegistry on the next update cycle.
  } catch (err) {
    // Graceful fallback
  }
}

/**
 * Clear all tracked change highlights from the CSS Highlight API.
 */
function clearHighlights(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;

  try {
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

/**
 * Clear all decorations — highlights, registry, and DeletedTextNodes.
 * Used on unmount and when the editor has no content.
 */
function clearAllDecorations(): void {
  clearHighlights();
  highlightRegistry.clear();
  deletionRegistry.clear();
}

/**
 * Apply decorations for a single change to the editor.
 * Used by the public addDecorationsForChange API.
 */
function applyDecorationsForSingleChange(
  editor: LexicalEditor,
  change: TrackedChange,
): void {
  if (change.field !== 'content' || change.status !== 'pending') return;

  editor.update(
    () => {
      const root = $getRoot();

      // Build clean text
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
        if (cleanText.length > startOffset && startOffset > 0) {
          paragraphBoundaries.push(startOffset);
        }
      }

      let cleanTextWithNewlines = '';
      {
        let lastIdx = 0;
        for (const boundary of paragraphBoundaries) {
          cleanTextWithNewlines += cleanText.slice(lastIdx, boundary) + '\n';
          lastIdx = boundary;
        }
        cleanTextWithNewlines += cleanText.slice(lastIdx);
      }

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

      if (!cleanText) return;

      const getDisplayableText = (content: string): string => {
        if (!content) return '';
        if (isLexicalJson(content)) {
          return extractTextFromLexical(content);
        }
        return content;
      };

      const rawOld = change.richTextOldValue || change.oldValue || '';
      const rawNew = change.richTextNewValue || change.newValue || '';
      const fullNewDisplay = rawNew ? getDisplayableText(rawNew) : '';
      const fullOldDisplay = rawOld ? getDisplayableText(rawOld) : '';

      if (!fullNewDisplay && !fullOldDisplay) return;

      const SEGMENT_SEPARATOR = ' \u2026 ';
      const newSegments = fullNewDisplay.split(SEGMENT_SEPARATOR);
      const oldSegments = fullOldDisplay.split(SEGMENT_SEPARATOR);

      const additionRanges: Array<{ start: number; end: number; colorIndex: number }> = [];
      const deletionInsertions: Array<{
        proposedCharOffset: number;
        deletedText: string;
        authorName?: string;
        authorColor?: string;
      }> = [];

      const segCount = Math.max(newSegments.length, oldSegments.length);
      for (let si = 0; si < segCount; si++) {
        const newDisplayText = (newSegments[si] || '').trim();
        const oldDisplayText = (oldSegments[si] || '').trim();
        if (!newDisplayText && !oldDisplayText) continue;

        let newTextStart = cleanTextWithNewlines.indexOf(newDisplayText);
        if (newTextStart === -1) {
          const stripped = newDisplayText.replace(/\n/g, '');
          newTextStart = cleanText.indexOf(stripped);
        }
        if (newTextStart === -1) continue;

        const charDiff = diffCharsOptimized(
          oldDisplayText, newDisplayText, { paragraphAligned: true },
        );

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
              colorIndex: changeColorIndex,
            });
            newOffset += seg.value.length;
          } else if (seg.type === 'delete') {
            const deletedText = seg.value.replace(/^\n+|\n+$/g, '');
            if (deletedText) {
              deletionInsertions.push({
                proposedCharOffset: newlinedToClean(newTextStart + newOffset),
                deletedText,
                authorName: change.changedBy,
                authorColor: changeColor,
              });
            }
          }
        }
      }

      // Insert DeletedTextNodes
      const sortedDeletions = [...deletionInsertions].sort(
        (a, b) => b.proposedCharOffset - a.proposedCharOffset
      );

      for (const deletion of sortedDeletions) {
        const nodeKey = insertDeletedTextNodeAtOffset(
          deletion.proposedCharOffset,
          change.id,
          deletion.deletedText,
          deletion.authorName,
          deletion.authorColor,
          paragraphBoundaries,
        );

        if (nodeKey) {
          let record = deletionRegistry.get(change.id);
          if (!record) {
            record = { nodeKeys: [], specs: [] };
            deletionRegistry.set(change.id, record);
          }
          record.nodeKeys.push(nodeKey);
          record.specs.push(deletion);
        }
      }

      // Register highlight records
      if (additionRanges.length > 0) {
        const record: ChangeHighlightRecord = {
          colorIndex: additionRanges[0].colorIndex,
          charRanges: additionRanges.map(r => ({ start: r.start, end: r.end })),
        };
        highlightRegistry.set(change.id, record);
      }

      // Rebuild highlights after DOM reconciliation
      requestAnimationFrame(() => {
        rebuildAllHighlightsFromRegistry(editor);
        suppressSpellcheckNearDeletions(editor);
      });
    },
    { tag: 'historic' }
  );
}
