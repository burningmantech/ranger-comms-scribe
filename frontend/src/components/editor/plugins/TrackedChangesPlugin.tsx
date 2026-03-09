import { useEffect, useRef, useCallback } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getNodeByKey,
  $isTextNode,
  TextNode,
  LexicalEditor,
  NodeKey,
  LexicalNode,
  $isElementNode,
  ElementNode,
  $nodesOfType,
  $createTextNode,
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
  rejectedBy?: string;
  isIncremental?: boolean;
  completeProposedVersion?: string;
  regionMap?: { field: string; ranges: Array<{ start: number; end: number }> };
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
          const node = $getNodeByKey(nodeKey);
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
              const node = $getNodeByKey(nodeKey);
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
                const node = $getNodeByKey(nodeKey);
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
                  const node = $getNodeByKey(nodeKey);
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
          const children = root.getChildren();
          for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const startOffset = cleanText.length;
            if (i > 0) {
              paragraphBoundaries.push(startOffset);
            }
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

          // Only diff changes that need new decorations
          const changesToProcess = contentChanges.filter(c => newChangeIds.has(c.id));

          for (const change of changesToProcess) {
            // Use the full document JSON if available for a perfect diff, fallback to the (potentially truncated) plain text values
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

              if (newDisplayText === '' && change.regionMap?.ranges?.[0] && change.completeProposedVersion) {
                // Deletions are now stored natively as DeletedTextNodes.
                // We no longer need to dynamically re-insert them via text diffing.
                continue;
              }

              if (newTextStart === -1) {
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

  // Listen for commit-pending-deletion events from TrackedChangesEditor
  useEffect(() => {
    const handleCommit = (e: Event) => {
      const customEvent = e as CustomEvent;
      const { newId } = customEvent.detail;
      if (newId) {
        editor.update(() => {
          const deletions = $nodesOfType(DeletedTextNode);
          for (const node of deletions) {
            if (node.getChangeId() === '__pending_deletion__') {
              node.setChangeId(newId);
              // Only update the first one we find so that multiple pending deletions
              // get their own unique IDs handled sequentially
              break;
            }
          }
        });
      }
    };
    window.addEventListener('commit-pending-deletion', handleCommit);
    return () => window.removeEventListener('commit-pending-deletion', handleCommit);
  }, [editor]);

  // Listen for resolve-tracked-change events from TrackedChangesEditor
  useEffect(() => {
    const handleResolve = (e: Event) => {
      const customEvent = e as CustomEvent;
      const { changeId, action } = customEvent.detail;
      if (changeId && action) {
        editor.update(() => {
          const deletions = $nodesOfType(DeletedTextNode);
          for (const node of deletions) {
            if (node.getChangeId() === changeId) {
              if (action === 'approve') {
                // Approving a deletion means the text is permanently deleted
                node.remove();
              } else if (action === 'reject') {
                // Rejecting a deletion means the text is restored
                const textNode = $createTextNode(node.getDeletedText());
                node.replace(textNode);
              }
            }
          }
        });
      }
    };
    window.addEventListener('resolve-tracked-change', handleResolve);
    return () => window.removeEventListener('resolve-tracked-change', handleResolve);
  }, [editor]);

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

  const blocks = root.getChildren();

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!$isElementNode(block)) continue;

    // Collect all TextNodes avoiding DeletedTextNodes
    const cleanChildren: LexicalNode[] = [];
    let blockTextLength = 0;

    const countText = (node: LexicalNode) => {
      if ($isDeletedTextNode(node)) return;
      if ($isTextNode(node)) {
        blockTextLength += node.getTextContentSize();
        cleanChildren.push(node);
      } else if ($isElementNode(node)) {
        for (const child of (node as ElementNode).getChildren()) countText(child);
      }
    };

    for (const child of (block as ElementNode).getChildren()) countText(child);

    const blockStart = cumulativeOffset;
    const blockEnd = cumulativeOffset + blockTextLength;
    const isLastBlock = i === blocks.length - 1;
    const isEmpty = blockTextLength === 0;

    // Check if charOffset falls into this block.
    // We match if it's strictly inside, or if it's empty and exactly here,
    // or if it's the last block and it's at the end.
    if ((charOffset >= blockStart && charOffset < blockEnd) ||
      (isEmpty && charOffset === blockStart) ||
      (isLastBlock && charOffset === blockEnd)) {

      const isBlockLevel = deletedText.includes('\n');
      const deletedNode = $createDeletedTextNode({ changeId, deletedText, authorName, authorColor, isBlockLevel });

      if (cleanChildren.length === 0) {
        // Safe to append directly to the empty paragraph
        (block as ElementNode).append(deletedNode);
        return deletedNode.getKey();
      }

      // Find the exact TextNode inside this block
      const localOffset = charOffset - blockStart;
      let childStart = 0;

      for (let j = 0; j < cleanChildren.length; j++) {
        const textNode = cleanChildren[j] as TextNode;
        const childLen = textNode.getTextContentSize();

        // Use <= to allow appending at the end of the text node
        if (localOffset >= childStart && localOffset <= childStart + childLen) {
          const NodeLocalOffset = localOffset - childStart;

          if (NodeLocalOffset === 0) {
            textNode.insertBefore(deletedNode);
          } else if (NodeLocalOffset >= childLen) {
            // Append after this text node if it's the right place
            if (j === cleanChildren.length - 1 || localOffset < childStart + childLen) {
              textNode.insertAfter(deletedNode);
            } else {
              // Exact boundary but not last child? Let the next child's NodeLocalOffset === 0 catch it
              childStart += childLen;
              continue;
            }
          } else {
            const [_left] = textNode.splitText(NodeLocalOffset);
            _left.insertAfter(deletedNode);
          }
          return deletedNode.getKey();
        }
        childStart += childLen;
      }
    }
    cumulativeOffset += blockTextLength;
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
