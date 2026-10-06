/**
 * The review sidebar's lists, built from the change records and comments:
 *
 *  - Open: pending changes (a deletion and an insertion of the same text by the same
 *    author shown as one "Moved" card) and comment threads, in document order;
 *  - History: who accepted or rejected what, newest first.
 *
 * Pure functions; the editor supplies document positions (from the reject locator).
 */
import type { Comment } from '../types/content';
import { ChangeDescription, describeChange, DescribableChange, normalizeText } from './changeDescriptions';

export type ChangeStatus = 'pending' | 'approved' | 'rejected';

/** What the lists need from a change record. */
export interface ReviewChangeLike extends DescribableChange {
  id: string;
  changedBy: string;
  timestamp: Date | string;
  status?: ChangeStatus;
  approvedBy?: string;
  approvedByName?: string;
  rejectedBy?: string;
  rejectedByName?: string;
  approvedAt?: Date | string;
  rejectedAt?: Date | string;
}

const time = (d: Date | string | undefined): number => (d ? new Date(d).getTime() || 0 : 0);

/** Only the changes still waiting for a decision. */
export function pendingOnly<T extends { status?: ChangeStatus }>(changes: T[]): T[] {
  return changes.filter((c) => (c.status || 'pending') === 'pending');
}

/**
 * Apply local status overrides (an undo sets a change back to pending before the server
 * data catches up). Returns the same array when nothing changes.
 */
export function applyStatusOverrides<T extends { id: string; status?: ChangeStatus }>(
  changes: T[],
  overrides: ReadonlyMap<string, ChangeStatus>,
): T[] {
  if (overrides.size === 0 || !changes.some((c) => overrides.has(c.id) && overrides.get(c.id) !== c.status)) return changes;
  return changes.map((c) => {
    const status = overrides.get(c.id);
    return status && status !== c.status ? { ...c, status } : c;
  });
}

// ---------------------------------------------------------------------------
// Change cards (with move pairing)
// ---------------------------------------------------------------------------

export type ChangeCard<T extends ReviewChangeLike> =
  | { type: 'change'; key: string; ids: string[]; change: T; description: ChangeDescription }
  | { type: 'move'; key: string; ids: string[]; deletion: T; insertion: T; description: ChangeDescription };

/** The author of a card (a move's two halves have the same author). */
export const cardAuthor = <T extends ReviewChangeLike>(card: ChangeCard<T>): string =>
  card.type === 'move' ? card.deletion.changedBy : card.change.changedBy;

/** The card's newest timestamp. */
export const cardTime = <T extends ReviewChangeLike>(card: ChangeCard<T>): number =>
  card.type === 'move' ? Math.max(time(card.deletion.timestamp), time(card.insertion.timestamp)) : time(card.change.timestamp);

/**
 * One card per change, except that a deletion and an insertion by the same author whose
 * text is the same (whitespace normalized) become one "Moved" card. Display only: the
 * card keeps both change ids, deletion first (the order a reject resolves them in).
 * Cards come out in the input order (a move at its earlier half).
 */
export function pairMoves<T extends ReviewChangeLike>(
  changes: T[],
  describe: (c: T) => ChangeDescription = describeChange,
): Array<ChangeCard<T>> {
  const described = changes.map((change) => ({ change, description: describe(change) }));
  const isContent = (c: T) => !c.field || c.field === 'content';
  const pairOf = new Map<number, number>(); // deletion index -> insertion index
  const paired = new Set<number>();
  const byTime = described.map((_, i) => i).sort((x, y) => time(described[x].change.timestamp) - time(described[y].change.timestamp));
  for (const di of byTime) {
    const d = described[di];
    if (paired.has(di) || d.description.kind !== 'deleted' || !isContent(d.change)) continue;
    const text = normalizeText(d.description.text);
    if (!text) continue;
    const ii = byTime.find((k) => {
      if (k === di || paired.has(k)) return false;
      const c = described[k];
      return c.description.kind === 'added' && isContent(c.change) &&
        c.change.changedBy === d.change.changedBy && normalizeText(c.description.text) === text;
    });
    if (ii === undefined) continue;
    pairOf.set(di, ii);
    paired.add(di);
    paired.add(ii);
  }

  const cards: Array<ChangeCard<T>> = [];
  const emitted = new Set<number>();
  described.forEach((d, i) => {
    if (emitted.has(i)) return;
    let partner: number | undefined = pairOf.get(i);
    let deletion = i;
    if (partner === undefined) {
      for (const [di, ii] of pairOf) if (ii === i) { partner = di; deletion = di; }
    }
    if (partner !== undefined) {
      const insertion = deletion === i ? partner : i;
      emitted.add(deletion);
      emitted.add(insertion);
      const del = described[deletion].change;
      const ins = described[insertion].change;
      cards.push({
        type: 'move',
        key: `move:${del.id}:${ins.id}`,
        ids: [del.id, ins.id],
        deletion: del,
        insertion: ins,
        description: { kind: 'moved', text: described[insertion].description.text },
      });
      return;
    }
    emitted.add(i);
    cards.push({ type: 'change', key: d.change.id, ids: [d.change.id], change: d.change, description: d.description });
  });
  return cards;
}

// ---------------------------------------------------------------------------
// Comment threads
// ---------------------------------------------------------------------------

export interface CommentNode extends Comment {
  replies: CommentNode[];
}

const CHANGE_REF = /@change:([A-Za-z0-9_-]+)/;
const REPLY_REF = /@reply:([A-Za-z0-9_-]+)/;

/** The change a comment is on, if any. */
export const commentChangeId = (c: Comment): string | undefined => c.content.match(CHANGE_REF)?.[1];

/** The comment's text without its @change / @reply references. */
export const commentText = (c: Comment): string =>
  c.content.replace(/@change:[A-Za-z0-9_-]+/g, '').replace(/@reply:[A-Za-z0-9_-]+/g, '').trim();

/** Comments as threads: root comments (oldest first) with their replies nested at any depth. */
export function buildCommentThreads(comments: Comment[]): CommentNode[] {
  const nodes = new Map<string, CommentNode>();
  for (const c of comments) nodes.set(c.id, { ...c, replies: [] });
  const roots: CommentNode[] = [];
  for (const c of comments) {
    const node = nodes.get(c.id)!;
    const parentId = c.content.match(REPLY_REF)?.[1];
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) parent.replies.push(node);
    else roots.push(node);
  }
  const byTime = (x: CommentNode, y: CommentNode) => time(x.createdAt) - time(y.createdAt);
  const sortDeep = (list: CommentNode[]) => {
    list.sort(byTime);
    list.forEach((n) => sortDeep(n.replies));
  };
  sortDeep(roots);
  return roots;
}

/** The change a thread is on: its root's @change reference (replies inherit it). */
export const threadChangeId = (thread: CommentNode): string | undefined => commentChangeId(thread);

/** Number of comments in a thread (root and every reply). */
export const threadSize = (thread: CommentNode): number =>
  1 + thread.replies.reduce((n, r) => n + threadSize(r), 0);

// ---------------------------------------------------------------------------
// The Open list
// ---------------------------------------------------------------------------

export type OpenItem<T extends ReviewChangeLike> =
  | (ChangeCard<T> & { threads: CommentNode[] })
  | { type: 'comment'; key: string; ids: string[]; thread: CommentNode; changeId?: string };

/**
 * Order items by document position: items with a position first (ascending), then those
 * that couldn't be located, in their existing order. Stable.
 */
export function orderByPosition<I>(items: I[], positionOf: (item: I) => number | undefined): I[] {
  const located: Array<{ item: I; pos: number; i: number }> = [];
  const rest: I[] = [];
  items.forEach((item, i) => {
    const pos = positionOf(item);
    if (pos === undefined || !Number.isFinite(pos)) rest.push(item);
    else located.push({ item, pos, i });
  });
  located.sort((x, y) => x.pos - y.pos || x.i - y.i);
  return [...located.map((x) => x.item), ...rest];
}

/**
 * Everything open: pending change cards (with their comment threads) and the comment
 * threads that aren't on a pending change, in document order. `positions` maps change ids
 * to document positions (the reject locator's unit index); a card's position is its
 * earliest change, a thread's the change it is on. Items without a position go last.
 */
/**
 * The number of edits still to accept or reject, as the review sidebar shows them: one per
 * card (a move's deletion and insertion are one), comments not counted. Takes Open items,
 * or change records (only the pending ones count).
 */
export function countOpenEdits<T extends ReviewChangeLike>(itemsOrChanges: Array<OpenItem<T>> | T[]): number {
  if (itemsOrChanges.length === 0) return 0;
  const first = itemsOrChanges[0] as any;
  if (first && typeof first.type === 'string' && Array.isArray(first.ids)) {
    return (itemsOrChanges as Array<OpenItem<T>>).filter((i) => i.type !== 'comment').length;
  }
  return pairMoves(pendingOnly(itemsOrChanges as T[])).length;
}

export function buildOpenItems<T extends ReviewChangeLike>(
  pendingChanges: T[],
  comments: Comment[],
  positions: ReadonlyMap<string, number>,
  describe?: (c: T) => ChangeDescription,
): Array<OpenItem<T>> {
  const sorted = [...pendingChanges].sort((x, y) => time(x.timestamp) - time(y.timestamp));
  const cards = pairMoves(sorted, describe);
  const threads = buildCommentThreads(comments);
  const cardOfChange = new Map<string, OpenItem<T>>();
  const items: Array<OpenItem<T>> = cards.map((card) => {
    const item = { ...card, threads: [] as CommentNode[] };
    card.ids.forEach((id) => cardOfChange.set(id, item));
    return item;
  });
  for (const thread of threads) {
    const changeId = threadChangeId(thread);
    const card = changeId ? cardOfChange.get(changeId) : undefined;
    if (card && card.type !== 'comment') card.threads.push(thread);
    else items.push({ type: 'comment', key: `comment:${thread.id}`, ids: changeId ? [changeId] : [], thread, changeId });
  }
  const positionOf = (item: OpenItem<T>): number | undefined => {
    const found = item.ids.map((id) => positions.get(id)).filter((p): p is number => p !== undefined);
    return found.length > 0 ? Math.min(...found) : undefined;
  };
  return orderByPosition(items, positionOf);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry<T extends ReviewChangeLike> {
  key: string;
  ids: string[];
  status: 'approved' | 'rejected';
  card: ChangeCard<T>;
  /** Stored user reference (id or email) and display name of who decided. */
  resolverId?: string;
  resolverName?: string;
  /** When it was decided (ms); 0 when unknown. */
  at: number;
}

/**
 * Accepted and rejected changes, newest decision first. A move whose two halves got the
 * same decision is one entry. `decidedAt` supplies decision times recorded locally for
 * changes whose record has none yet.
 */
export function buildHistory<T extends ReviewChangeLike>(
  changes: T[],
  decidedAt: ReadonlyMap<string, number> = new Map(),
  describe?: (c: T) => ChangeDescription,
): Array<HistoryEntry<T>> {
  const at = (c: T) => (c.status === 'approved' ? time(c.approvedAt) : time(c.rejectedAt)) || decidedAt.get(c.id) || 0;
  const entries: Array<HistoryEntry<T>> = [];
  for (const status of ['approved', 'rejected'] as const) {
    const resolved = changes.filter((c) => c.status === status).sort((x, y) => time(x.timestamp) - time(y.timestamp));
    for (const card of pairMoves(resolved, describe)) {
      const first = card.type === 'move' ? card.deletion : card.change;
      const halves = card.type === 'move' ? [card.deletion, card.insertion] : [card.change];
      entries.push({
        key: `${status}:${card.key}`,
        ids: card.ids,
        status,
        card,
        resolverId: status === 'approved' ? first.approvedBy : first.rejectedBy,
        resolverName: status === 'approved' ? first.approvedByName : first.rejectedByName,
        at: Math.max(...halves.map(at)),
      });
    }
  }
  return entries.sort((x, y) => y.at - x.at);
}
