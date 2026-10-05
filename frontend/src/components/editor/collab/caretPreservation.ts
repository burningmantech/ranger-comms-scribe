/**
 * Keeps the local caret where the user was typing when other users' edits merge in
 * (collaborative mode).
 *
 * Two problems with @lexical/yjs 0.30's own caret recovery:
 *
 * 1. It anchors the caret to the character on its RIGHT (Yjs relative position, assoc 0).
 *    When someone else inserts at the same place, their text lands between your last
 *    character and that anchor, the caret jumps past it, and your next keystrokes
 *    interleave with theirs ("xyxyxy"). Here the caret is anchored to the character on its
 *    LEFT (assoc -1), usually the one you just typed, so each user's text stays contiguous.
 *
 * 2. A paragraph split (Enter) or a format split (bold) is synced as delete plus re-insert:
 *    the moved text gets new Yjs items, and a position anchored in it falls back to the
 *    split point. So the text around the caret (up to 32 characters before it, 8 after it,
 *    within its block) is recorded too. If the restored caret's left context doesn't match,
 *    the context is searched for (in place, or across the new paragraph break) and the
 *    caret moves to the closest unique match. Not found or ambiguous: the relative
 *    position wins.
 *
 * 3. Characters the user typed while the other user's split was in flight are anchored to
 *    text the split moved, so Yjs leaves them behind at the split point. When the caret's
 *    own recent characters sit right after deleted (moved) text and the context without
 *    them is found elsewhere, those characters are moved there with the caret. This is
 *    the only content edit made here: the user's own just-typed text, in a normal local
 *    update (it syncs and belongs to their tracked change).
 *
 * Capture happens just before each remote Yjs transaction (from the selection that
 * @lexical/yjs keeps in the awareness state, converted to a left-anchored position while
 * the doc is still in its pre-update state). The restore is a selection-only follow-up
 * update right after the remote update commits, tagged 'skip-scroll-into-view'. It
 * changes no content (nothing syncs) and only runs while the editor has focus.
 */
import * as Y from 'yjs';
import {
  $createRangeSelection,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  ElementNode,
  LexicalEditor,
  LexicalNode,
  PointType,
  TextNode,
} from 'lexical';
import { getAnchorAndFocusCollabNodesForUserState } from '@lexical/yjs';

export const LEFT_CONTEXT_CHARS = 32;
export const RIGHT_CONTEXT_CHARS = 8;
/** Below this, a left context is too short to search for safely. */
const MIN_SEARCH_CONTEXT = 3;
/** Own characters typed this recently can be "in flight" when a remote split arrives. */
export const RECENT_TYPING_MS = 5000;

export interface CaretPreservationOptions {
  editor: LexicalEditor;
  doc: Y.Doc;
  /** True for transactions that apply other users' updates (the provider is the origin). */
  isRemoteOrigin: (origin: unknown) => boolean;
  /** The local awareness state, where @lexical/yjs writes the local selection (anchorPos/focusPos). */
  getLocalAwarenessState: () => { anchorPos?: Y.RelativePosition | null; focusPos?: Y.RelativePosition | null } | null;
  /** Whether the editor has focus; nothing is captured or restored otherwise. */
  isFocused: () => boolean;
  /**
   * Which local transactions are the user's own typing (not the seed or tracked-change
   * bookkeeping). Only those characters can be moved back after a split.
   */
  isOwnEdit: (tr: Y.Transaction) => boolean;
}

interface CaretContext {
  left: string;
  right: string;
}

/** Which of this client's Yjs clocks were inserted recently (by local transactions). */
export interface RecentInserts {
  isRecent(clock: number): boolean;
}

interface PendingCaret {
  anchor: Y.RelativePosition;
  focus: Y.RelativePosition;
  collapsed: boolean;
  context: CaretContext | null;
  capturedBy: Y.Transaction;
}

// ---- Block text helpers (run inside an editor read or update) ----

/** Nearest non-inline element containing `node` (the caret's paragraph, heading or list item). */
function $blockOf(node: LexicalNode): ElementNode | null {
  let current: LexicalNode | null = $isElementNode(node) && !node.isInline() ? node : node.getParent();
  while (current !== null) {
    if ($isElementNode(current) && !current.isInline()) return current;
    current = current.getParent();
  }
  return null;
}

interface Leaf {
  node: LexicalNode;
  start: number;
  size: number;
}

/** The block's leaves in order with their offsets in the block's text (same text as getTextContent). */
function $leavesOf(block: ElementNode): { text: string; leaves: Leaf[] } {
  const leaves: Leaf[] = [];
  let text = '';
  const walk = (node: LexicalNode) => {
    if ($isElementNode(node)) {
      if (node !== block && !node.isInline()) return; // nested blocks are their own blocks
      for (const child of node.getChildren()) walk(child);
      return;
    }
    const content = $isTextNode(node) ? node.getTextContent() : $isLineBreakNode(node) ? '\n' : node.getTextContent();
    leaves.push({ node, start: text.length, size: content.length });
    text += content;
  };
  walk(block);
  return { text, leaves };
}

/** Offset of a text point within its block's text, or null for non-text points. */
function $pointToBlockOffset(point: PointType): { block: ElementNode; offset: number; text: string } | null {
  if (point.type !== 'text') return null;
  const node = point.getNode();
  if (!$isTextNode(node)) return null;
  const block = $blockOf(node);
  if (!block) return null;
  const { text, leaves } = $leavesOf(block);
  const leaf = leaves.find((l) => l.node.is(node));
  if (!leaf) return null;
  return { block, offset: leaf.start + Math.min(point.offset, leaf.size), text };
}

/** Text point at `offset` in `block` (end of the preceding text node at boundaries, so typing continues there). */
function $blockOffsetToPoint(block: ElementNode, offset: number): { key: string; offset: number; type: 'text' | 'element' } {
  const { leaves } = $leavesOf(block);
  let firstText: Leaf | null = null;
  for (const leaf of leaves) {
    if (!$isTextNode(leaf.node)) continue;
    if (!firstText) firstText = leaf;
    if (offset > leaf.start && offset <= leaf.start + leaf.size) {
      return { key: leaf.node.getKey(), offset: offset - leaf.start, type: 'text' };
    }
  }
  for (const leaf of leaves) {
    if ($isTextNode(leaf.node) && offset === leaf.start) {
      return { key: leaf.node.getKey(), offset: 0, type: 'text' };
    }
  }
  if (firstText && offset <= 0) return { key: firstText.node.getKey(), offset: 0, type: 'text' };
  return { key: block.getKey(), offset: 0, type: 'element' };
}

/** Every leaf block (paragraphs, headings, list items, ...) in document order. */
function $leafBlocks(): ElementNode[] {
  const blocks: ElementNode[] = [];
  const walk = (node: ElementNode) => {
    const childBlocks = node.getChildren().filter((c): c is ElementNode => $isElementNode(c) && !c.isInline());
    if (node !== $getRoot() && childBlocks.length === 0) {
      blocks.push(node);
      return;
    }
    for (const child of node.getChildren()) {
      if ($isElementNode(child) && !child.isInline()) walk(child);
    }
  };
  walk($getRoot());
  return blocks;
}

function $captureContext(): CaretContext | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const at = $pointToBlockOffset(selection.anchor);
  if (!at) return null;
  return {
    left: at.text.slice(Math.max(0, at.offset - LEFT_CONTEXT_CHARS), at.offset),
    right: at.text.slice(at.offset, at.offset + RIGHT_CONTEXT_CHARS),
  };
}

/**
 * Where the recorded context now is, if the restored caret isn't next to it: the closest
 * unique match, in place or across a paragraph break inserted inside it.
 */
function $findContext(
  context: CaretContext,
  restored: { block: ElementNode; offset: number },
  /** Text to leave out of the search (offsets in the result are then as if it were removed). */
  exclude?: { block: ElementNode; start: number; end: number },
): { block: ElementNode; offset: number } | null {
  const { left, right } = context;
  if (left.length < MIN_SEARCH_CONTEXT) return null;
  const blocks = $leafBlocks();
  const texts = blocks.map((b) => {
    const t = $leavesOf(b).text;
    return exclude && b.is(exclude.block) ? t.slice(0, exclude.start) + t.slice(exclude.end) : t;
  });
  const starts: number[] = [];
  let total = 0;
  for (const t of texts) {
    starts.push(total);
    total += t.length + 1;
  }
  const restoredIndex = blocks.findIndex((b) => b.is(restored.block));
  const restoredGlobal = restoredIndex === -1 ? 0 : starts[restoredIndex] + restored.offset;

  const candidates: Array<{ blockIndex: number; offset: number; rightMatches: boolean }> = [];
  const searchIn = (needle: string, withRight: boolean) => {
    texts.forEach((t, i) => {
      let from = 0;
      for (;;) {
        const idx = t.indexOf(needle, from);
        if (idx === -1) break;
        const offset = idx + left.length;
        if (!candidates.some((c) => c.blockIndex === i && c.offset === offset)) {
          candidates.push({ blockIndex: i, offset, rightMatches: withRight || t.slice(offset, offset + right.length) === right });
        }
        from = idx + 1;
      }
    });
  };
  // In place (format split, or any edit that left the context intact)
  if (right) searchIn(left + right, true);
  if (candidates.length === 0) searchIn(left, false);
  // Split by a paragraph break: the context's end starts a block, its beginning ends the previous one.
  for (let i = 1; i < texts.length; i++) {
    const t = texts[i];
    for (let len = Math.min(left.length - 1, t.length); len >= 1; len--) {
      const suffix = left.slice(left.length - len);
      const prefix = left.slice(0, left.length - len);
      if (t.startsWith(suffix) && texts[i - 1].endsWith(prefix)) {
        if (!candidates.some((c) => c.blockIndex === i && c.offset === len)) {
          candidates.push({ blockIndex: i, offset: len, rightMatches: t.slice(len, len + right.length) === right });
        }
        break;
      }
    }
  }
  if (candidates.length === 0) return null;
  // Prefer candidates whose right context matches too, then the closest to the restored caret.
  const pool = candidates.some((c) => c.rightMatches) ? candidates.filter((c) => c.rightMatches) : candidates;
  const scored = pool
    .map((c) => ({ ...c, distance: Math.abs(starts[c.blockIndex] + c.offset - restoredGlobal) }))
    .sort((a, b) => a.distance - b.distance);
  if (scored.length > 1 && scored[0].distance === scored[1].distance) return null; // ambiguous
  return { block: blocks[scored[0].blockIndex], offset: scored[0].offset };
}

/**
 * The run of this client's recently typed characters ending at `index` in `type`, and
 * whether it was left behind by moved text: its first character's left neighbour (in Yjs
 * order, deleted items included) is deleted. Returns '' when there's no such run.
 */
export function orphanedOwnRun(type: Y.AbstractType<any>, index: number, clientID: number, recent: RecentInserts): string {
  const chars: Array<{ item: Y.Item; offset: number; char: string }> = [];
  for (let item = type._start; item !== null && chars.length < index; item = item.right) {
    if (item.deleted || !item.countable) continue;
    const content = item.content;
    if (content instanceof Y.ContentString) {
      const str = (content as any).str as string;
      for (let k = 0; k < str.length && chars.length < index; k++) chars.push({ item, offset: k, char: str[k] });
    } else {
      for (let k = 0; k < item.length && chars.length < index; k++) chars.push({ item, offset: k, char: '' });
    }
  }
  if (chars.length < index) return '';
  // Walk back over own recent characters to the first one whose left neighbour was
  // deleted (the moved text it was typed after).
  for (let start = chars.length - 1; start >= 0; start--) {
    const c = chars[start];
    if (!c.char || c.item.id.client !== clientID || !recent.isRecent(c.item.id.clock + c.offset)) return '';
    if (c.offset === 0 && c.item.left !== null && c.item.left.deleted) {
      return chars.slice(start).map((x) => x.char).join('');
    }
  }
  return '';
}

/** Remove block text [start, end) (inside an update). */
function $removeBlockRange(block: ElementNode, start: number, end: number): void {
  const { leaves } = $leavesOf(block);
  for (let i = leaves.length - 1; i >= 0; i--) {
    const leaf = leaves[i];
    if (!$isTextNode(leaf.node)) continue;
    const from = Math.max(start, leaf.start);
    const to = Math.min(end, leaf.start + leaf.size);
    if (from >= to) continue;
    const node = leaf.node as TextNode;
    if (to - from === leaf.size) node.remove();
    else node.spliceText(from - leaf.start, to - from, '', false);
  }
}

/** $setPoint from @lexical/yjs: a position on a decorator or line break goes to its parent. */
function $setPointFromCollab(point: PointType, key: string, offset: number): void {
  let node = $getNodeByKey(key);
  if (node !== null && !$isElementNode(node) && !$isTextNode(node)) {
    const parent = node.getParentOrThrow();
    key = parent.getKey();
    offset = node.getIndexWithinParent();
    node = parent;
  }
  if ($isTextNode(node)) {
    offset = Math.min(offset, (node as TextNode).getTextContentSize());
  } else if ($isElementNode(node)) {
    offset = Math.min(offset, node.getChildrenSize());
  }
  point.set(key, offset, $isElementNode(node) ? 'element' : 'text');
}

/** The restore itself, inside an editor update. Exported for tests. */
export function $restoreCaret(
  doc: Y.Doc,
  pending: Pick<PendingCaret, 'anchor' | 'focus' | 'collapsed' | 'context'>,
  recent?: RecentInserts,
): boolean {
  const resolved = getAnchorAndFocusCollabNodesForUserState(
    // Only `doc` is read (to resolve the relative positions); the collab nodes come from the shared types.
    { doc } as unknown as Parameters<typeof getAnchorAndFocusCollabNodesForUserState>[0],
    { anchorPos: pending.anchor, focusPos: pending.focus } as unknown as Parameters<typeof getAnchorAndFocusCollabNodesForUserState>[1],
  );
  if (resolved.anchorCollabNode === null || resolved.focusCollabNode === null) return false;
  const selection = $createRangeSelection();
  $setPointFromCollab(selection.anchor, resolved.anchorCollabNode.getKey(), resolved.anchorOffset);
  $setPointFromCollab(selection.focus, resolved.focusCollabNode.getKey(), resolved.focusOffset);

  if (pending.collapsed && pending.context) {
    const at = $pointToBlockOffset(selection.anchor);
    const leftNow = at ? at.text.slice(Math.max(0, at.offset - pending.context.left.length), at.offset) : null;
    if (at && leftNow !== pending.context.left) {
      // Own characters left behind at the split point: move them back with the caret.
      const abs = recent ? Y.createAbsolutePositionFromRelativePosition(pending.anchor, doc) : null;
      const run = abs && recent ? orphanedOwnRun(abs.type, abs.index, doc.clientID, recent) : '';
      if (run && pending.context.left.endsWith(run) && at.text.slice(0, at.offset).endsWith(run)) {
        const context = { left: pending.context.left.slice(0, pending.context.left.length - run.length), right: pending.context.right };
        const runStart = { block: at.block, offset: at.offset - run.length };
        // Search as if the stray run weren't there (it's still at the split point).
        const found = $findContext(context, runStart, { block: at.block, start: runStart.offset, end: at.offset });
        if (found && !(found.block.is(at.block) && found.offset === runStart.offset)) {
          $removeBlockRange(at.block, runStart.offset, at.offset);
          const point = $blockOffsetToPoint(found.block, found.offset);
          selection.anchor.set(point.key, point.offset, point.type);
          selection.focus.set(point.key, point.offset, point.type);
          $setSelection(selection);
          selection.insertText(run);
          return true;
        }
      }
      const found = $findContext(pending.context, at);
      if (found) {
        const point = $blockOffsetToPoint(found.block, found.offset);
        selection.anchor.set(point.key, point.offset, point.type);
        selection.focus.set(point.key, point.offset, point.type);
      }
    }
  }
  const current = $getSelection();
  if ($isRangeSelection(current)) {
    selection.format = current.format;
    selection.style = current.style;
  }
  $setSelection(selection);
  return true;
}

/** Wire caret preservation to an editor and its Y.Doc. Returns the cleanup function. */
export function registerCaretPreservation(options: CaretPreservationOptions): () => void {
  const { editor, doc, isRemoteOrigin, getLocalAwarenessState, isFocused, isOwnEdit } = options;
  let pending: PendingCaret | null = null;
  const recentRanges: Array<{ start: number; end: number; time: number }> = [];
  const recent: RecentInserts = {
    isRecent(clock: number) {
      const cutoff = Date.now() - RECENT_TYPING_MS;
      return recentRanges.some((r) => r.time >= cutoff && clock >= r.start && clock < r.end);
    },
  };

  const onBeforeTransaction = (tr: Y.Transaction) => {
    if (pending || !isRemoteOrigin(tr.origin) || !isFocused()) return;
    const state = getLocalAwarenessState();
    if (!state || !state.anchorPos || !state.focusPos) return;
    // Still the pre-update doc: resolve the current caret and re-anchor it to the left.
    const anchorAbs = Y.createAbsolutePositionFromRelativePosition(state.anchorPos, doc);
    const focusAbs = Y.createAbsolutePositionFromRelativePosition(state.focusPos, doc);
    if (!anchorAbs || !focusAbs) return;
    const collapsed = anchorAbs.type === focusAbs.type && anchorAbs.index === focusAbs.index;
    const context = collapsed ? editor.getEditorState().read($captureContext) : null;
    pending = {
      anchor: collapsed ? Y.createRelativePositionFromTypeIndex(anchorAbs.type, anchorAbs.index, -1) : state.anchorPos,
      focus: collapsed ? Y.createRelativePositionFromTypeIndex(focusAbs.type, focusAbs.index, -1) : state.focusPos,
      collapsed,
      context,
      capturedBy: tr,
    };
  };
  const onAfterTransaction = (tr: Y.Transaction) => {
    if (tr.local && !isRemoteOrigin(tr.origin) && isOwnEdit(tr)) {
      const start = tr.beforeState.get(doc.clientID) || 0;
      const end = tr.afterState.get(doc.clientID) || 0;
      if (end > start) {
        const now = Date.now();
        recentRanges.push({ start, end, time: now });
        while (recentRanges.length && recentRanges[0].time < now - RECENT_TYPING_MS) recentRanges.shift();
      }
    }
    // A remote transaction that changed nothing produces no editor update to restore after.
    if (pending && pending.capturedBy === tr && tr.changedParentTypes.size === 0 && tr.deleteSet.clients.size === 0) {
      pending = null;
    }
  };
  doc.on('beforeTransaction', onBeforeTransaction);
  doc.on('afterTransaction', onAfterTransaction);

  const removeUpdateListener = editor.registerUpdateListener(({ tags }) => {
    if (!pending) return;
    if (!tags.has('collaboration')) {
      pending = null;
      return;
    }
    const caret = pending;
    pending = null;
    if (!isFocused()) return;
    editor.update(() => {
      $restoreCaret(doc, caret, recent);
    }, { tag: 'skip-scroll-into-view' });
  });

  return () => {
    doc.off('beforeTransaction', onBeforeTransaction);
    doc.off('afterTransaction', onAfterTransaction);
    removeUpdateListener();
  };
}
