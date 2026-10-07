/**
 * The local user's own edits since a point in time, so a tracked change can stay open
 * while other users' edits merge in (collaborative mode).
 *
 * When a tracked change settles, its before-state is the current document with this
 * user's edits taken out, and its after-state is the current document. Both contain every
 * edit merged from other users, so the diff is exactly this user's edits.
 *
 * "This user's edits" is decided by authorship, not by Yjs client, because @lexical/yjs
 * syncs structural edits as delete-and-copy (see provenance.ts):
 *   - characters whose original (through any copies) was typed by this user during the
 *     session are hidden, wherever they now are and whoever copied them;
 *   - characters this user really deleted are restored; text they only moved is not;
 *   - blocks this user created are kept (other users may have typed into them) and then
 *     undone structurally: a split-off block is merged back into the previous block, and a
 *     block that replaced another (type change) gets the old block's type back;
 *   - this user's other new items (decorators such as deletion markers, new text-node
 *     boundaries, attribute values) are hidden, restoring the previous values.
 *
 * Requires the Y.Doc to keep deleted content (`gc: false`).
 */
import * as Y from 'yjs';
import { $getNodeByKey, $isElementNode, $parseSerializedNode, createEditor, ElementNode, Klass, LexicalNode } from 'lexical';
import { createBinding, Provider, syncYjsChangesToLexical } from '@lexical/yjs';
import { CharKey, charKey, getProvenance, parseCharKey, Provenance } from './provenance';

interface Range {
  clock: number;
  len: number;
}

export interface LocalEditSession {
  /** Clock ranges of this client's items inserted by the local user's edits. */
  inserted: Range[];
  /** Items the local user's edits deleted. */
  deleted: Array<ReturnType<typeof Y.createDeleteSet>>;
  active: boolean;
}

export interface LocalEditTracker {
  /** Start recording the local user's edits (call before the first edit's Yjs transaction). */
  begin(): LocalEditSession;
  end(session: LocalEditSession): void;
  /** Lexical JSON of the document without the session's edits. */
  baselineJson(session: LocalEditSession): string;
  /** Lexical JSON of the current document, from the same conversion as baselineJson. */
  currentJson(): string;
  destroy(): void;
}

/** A block this user created, to undo structurally in the baseline. */
export interface ContainerFix {
  /** `${client}:${clock}` of the block's Yjs item. */
  id: CharKey;
  /** 'merge': fold it into the previous block. 'revert': give it the replaced block's attributes. */
  kind: 'merge' | 'revert';
  /** For 'revert': the replaced block's Lexical attributes (`__type`, `__tag`, ...). */
  oldAttributes?: Record<string, unknown>;
}

/** Minimal provider for a headless binding: no awareness, no cursors. */
const headlessProvider = {
  awareness: {
    getLocalState: () => null,
    getStates: () => new Map(),
    off: () => {},
    on: () => {},
    setLocalState: () => {},
    setLocalStateField: () => {},
  },
  connect: () => {},
  disconnect: () => {},
  off: () => {},
  on: () => {},
} as unknown as Provider;

function $applyContainerFix(node: ElementNode, fix: ContainerFix): void {
  if (fix.kind === 'revert' && fix.oldAttributes && typeof fix.oldAttributes.__type === 'string') {
    const json: Record<string, unknown> = { ...(node.exportJSON() as any), children: [] };
    for (const [key, value] of Object.entries(fix.oldAttributes)) {
      if (key.startsWith('__') && key !== '__dir') json[key.slice(2)] = value;
    }
    const replacement = $parseSerializedNode(json as any);
    if (!$isElementNode(replacement)) return;
    replacement.append(...node.getChildren());
    node.replace(replacement);
    return;
  }
  // merge: undo the split that created this block
  const previous = node.getPreviousSibling();
  if ($isElementNode(previous) && !previous.isInline()) {
    previous.append(...node.getChildren());
    node.remove();
    return;
  }
  const next = node.getNextSibling();
  if ($isElementNode(next) && !next.isInline()) {
    next.splice(0, 0, node.getChildren());
    node.remove();
  }
}

/**
 * Convert a Y.Doc holding a Lexical document into Lexical JSON (headless editor, same
 * mapping as the live editor), then apply structural fixes to blocks identified by Yjs item.
 */
export function lexicalJsonFromYDoc(
  source: Y.Doc,
  nodes: ReadonlyArray<Klass<LexicalNode>>,
  fixes: ContainerFix[] = [],
): string {
  const editor = createEditor({ namespace: 'collab-baseline', nodes: nodes as Array<Klass<LexicalNode>>, onError: (e) => { throw e; } });
  const target = new Y.Doc();
  const docMap = new Map<string, Y.Doc>([['baseline', target]]);
  const binding = createBinding(editor, headlessProvider, 'baseline', target, docMap);
  const onEvents = (events: Array<Y.YEvent<any>>, transaction: Y.Transaction) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexical(binding, headlessProvider, events as any, false, () => {});
    }
  };
  const shared = binding.root.getSharedType();
  shared.observeDeep(onEvents);
  try {
    Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
    editor.update(() => {}, { discrete: true }); // flush the pending sync
    if (fixes.length) {
      const byId = new Map(fixes.map((f) => [f.id, f]));
      const targets: Array<{ key: string; fix: ContainerFix }> = [];
      binding.collabNodeMap.forEach((collab: any, key: string) => {
        const item = collab?._xmlText?._item as Y.Item | null | undefined;
        if (!item) return;
        const fix = byId.get(charKey(item.id.client, item.id.clock));
        if (fix) targets.push({ key, fix });
      });
      if (targets.length) {
        editor.update(() => {
          // Reverts first; merges last-to-first so earlier blocks are still where they were.
          const ordered = [...targets].sort((a, b) => (a.fix.kind === b.fix.kind ? 0 : a.fix.kind === 'revert' ? -1 : 1));
          const merges = ordered.filter((t) => t.fix.kind === 'merge').reverse();
          for (const t of [...ordered.filter((x) => x.fix.kind === 'revert'), ...merges]) {
            const node = $getNodeByKey(t.key);
            if ($isElementNode(node) && node.isAttached()) $applyContainerFix(node, t.fix);
          }
        }, { discrete: true });
      }
    }
    return JSON.stringify(editor.getEditorState());
  } finally {
    shared.unobserveDeep(onEvents);
    target.destroy();
  }
}

/** `ranges` minus `remove` (both sorted, non-overlapping). */
function subtractRanges(ranges: Range[], remove: Range[]): Range[] {
  if (!remove.length) return ranges.map((r) => ({ clock: r.clock, len: r.len }));
  const out: Range[] = [];
  for (const r of ranges) {
    let pieces: Range[] = [{ clock: r.clock, len: r.len }];
    for (const d of remove) {
      const next: Range[] = [];
      for (const p of pieces) {
        const pEnd = p.clock + p.len;
        const dEnd = d.clock + d.len;
        if (dEnd <= p.clock || d.clock >= pEnd) {
          next.push(p);
          continue;
        }
        if (d.clock > p.clock) next.push({ clock: p.clock, len: d.clock - p.clock });
        if (dEnd < pEnd) next.push({ clock: dEnd, len: pEnd - dEnd });
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out;
}

class RangeSet {
  private byClient = new Map<number, Range[]>();
  add(client: number, clock: number, len = 1): void {
    const list = this.byClient.get(client) || [];
    list.push({ clock, len });
    this.byClient.set(client, list);
  }
  toDeleteSet(): ReturnType<typeof Y.createDeleteSet> {
    const ds = Y.createDeleteSet();
    this.byClient.forEach((ranges, client) => ds.clients.set(client, ranges as any));
    return Y.mergeDeleteSets([ds]);
  }
}

function attributesOf(type: Y.AbstractType<any>): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  type._map.forEach((item, key) => {
    const values = item.content.getContent();
    attrs[key] = values[values.length - 1];
  });
  return attrs;
}

const isType = (item: Y.Item, ctor: any) => item.content instanceof Y.ContentType && (item.content as any).type instanceof ctor;

/**
 * A line break (CollabLineBreakNode: a Y.Map embed with __type 'linebreak'), not a
 * text-node boundary. Reads the raw attribute, so it works for deleted items too.
 */
const isLineBreak = (item: Y.Item) => {
  if (!isType(item, Y.Map)) return false;
  const attr = (item.content as any).type._map.get('__type') as Y.Item | undefined;
  const values = attr ? attr.content.getContent() : [];
  return values[values.length - 1] === 'linebreak';
};

/** Line breaks directly in a block (deleted ones included: for a deleted, replaced block). */
function lineBreaksIn(container: Y.Item): number {
  let count = 0;
  for (let item = ((container.content as any).type as Y.AbstractType<any>)._start; item !== null; item = item.right) {
    if (isLineBreak(item)) count++;
  }
  return count;
}

/**
 * The document state without the session's edits (a Yjs snapshot of every struct with an
 * adjusted delete set) plus the structural fixes to apply after conversion.
 */
export function baselineDoc(
  doc: Y.Doc,
  session: Pick<LocalEditSession, 'inserted' | 'deleted'>,
  provenance: Provenance | null = getProvenance(doc),
): { doc: Y.Doc; fixes: ContainerFix[] } {
  const me = doc.clientID;
  const inSession = (client: number, clock: number) =>
    client === me && session.inserted.some((r) => clock >= r.clock && clock < r.clock + r.len);
  const isMineKey = (key: CharKey) => {
    const { client, clock } = parseCharKey(key);
    return inSession(client, clock);
  };
  const rootOf = (key: CharKey) => (provenance ? provenance.rootOf(key) : key);
  const isMineItem = (item: Y.Item) => inSession(item.id.client, item.id.clock);

  // Pass 1: this user's new types that stay (blocks; the first text-node boundary in a block).
  const keptTypes = new Set<Y.Item>();
  // Line breaks aren't text-node boundaries: this user's new ones are hidden, so they
  // don't count here either.
  const firstLiveEmbed = (item: Y.Item) => {
    for (let left = item.left; left !== null; left = left.left) {
      if (!left.deleted && left.countable && isType(left, Y.Map) && !(isLineBreak(left) && isMineItem(left))) return false;
    }
    return true;
  };
  const keptBreaks = new Map<Y.Item, number>();
  const allItems: Y.Item[] = [];
  doc.store.clients.forEach((structs) => {
    for (const s of structs as Array<Y.Item | Y.GC>) if (s instanceof Y.Item) allItems.push(s);
  });
  for (const item of allItems) {
    if (item.deleted || item.parentSub !== null || !isMineItem(item)) continue;
    if (isType(item, Y.XmlText)) keptTypes.add(item);
    else if (isType(item, Y.Map)) {
      // A replacement block (type change) is a copy of the old one, text-node boundaries
      // and formats included: keep them all. Elsewhere a new boundary is a format split
      // to undo, except the first one in a block (its text needs a node).
      const parentItem = (item.parent as Y.AbstractType<any>)._item;
      const replacedBlock = parentItem && provenance ? provenance.replacedContainer(parentItem) : null;
      if (isLineBreak(item)) {
        // A new line break is this user's content, hidden, unless it is a copy in a
        // replacement block: as many as the replaced block had are kept. (A block that
        // only looks like a replacement, e.g. pasted over an empty paragraph, had none.)
        if (parentItem && replacedBlock) {
          const used = keptBreaks.get(parentItem) || 0;
          if (used < lineBreaksIn(replacedBlock)) {
            keptTypes.add(item);
            keptBreaks.set(parentItem, used + 1);
          }
        }
        continue;
      }
      if (replacedBlock || firstLiveEmbed(item)) keptTypes.add(item);
    }
  }

  // Pass 2: what to hide.
  const hidden = new RangeSet();
  for (const item of allItems) {
    if (item.deleted) continue;
    const { client, clock } = item.id;
    if (item.parentSub === null && item.content instanceof Y.ContentString) {
      const str = (item.content as any).str as string;
      for (let k = 0; k < str.length; k++) {
        if (isMineKey(rootOf(charKey(client, clock + k)))) hidden.add(client, clock + k);
      }
      continue;
    }
    if (!isMineItem(item)) continue;
    if (item.parentSub !== null) {
      const parentItem = (item.parent as Y.AbstractType<any>)._item;
      if (parentItem && keptTypes.has(parentItem)) continue; // attributes of a block we keep
      hidden.add(client, clock, item.length);
      continue;
    }
    if (keptTypes.has(item)) continue;
    hidden.add(client, clock, item.length);
  }

  // Real deletions to restore (not moves, not replaced blocks).
  const restored = new RangeSet();
  for (const ds of session.deleted) {
    ds.clients.forEach((ranges, client) => {
      const structs = doc.store.clients.get(client) as Array<Y.Item | Y.GC> | undefined;
      if (!structs) return;
      for (const r of ranges as Range[]) {
        for (let clock = r.clock; clock < r.clock + r.len; clock++) {
          if (provenance && provenance.isMoved(charKey(client, clock))) continue;
          let item: Y.Item | null = null;
          try {
            const s = structs[Y.findIndexSS(structs as any, clock)];
            item = s instanceof Y.Item ? s : null;
          } catch {
            item = null;
          }
          if (item && provenance && provenance.isReplacedContainer(item)) continue;
          restored.add(client, clock);
        }
      }
    });
  }

  const current = Y.createDeleteSetFromStructStore(doc.store);
  const restoredDs = restored.toDeleteSet();
  const ds = Y.createDeleteSet();
  current.clients.forEach((ranges, client) => {
    const kept = subtractRanges(ranges as Range[], (restoredDs.clients.get(client) as Range[] | undefined) || []);
    if (kept.length) ds.clients.set(client, kept as any);
  });
  const finalDs = Y.mergeDeleteSets([ds, hidden.toDeleteSet()]);

  // Structural fixes for this user's outermost new blocks.
  const fixes: ContainerFix[] = [];
  keptTypes.forEach((item) => {
    if (!isType(item, Y.XmlText)) return;
    const parentItem = (item.parent as Y.AbstractType<any>)._item;
    if (parentItem && keptTypes.has(parentItem)) return; // nested in another new block
    const old = provenance ? provenance.replacedContainer(item) : null;
    fixes.push(old
      ? { id: charKey(item.id.client, item.id.clock), kind: 'revert', oldAttributes: attributesOf((old.content as any).type) }
      : { id: charKey(item.id.client, item.id.clock), kind: 'merge' });
  });

  const snapshotDoc = Y.createDocFromSnapshot(doc, Y.createSnapshot(finalDs, Y.decodeStateVector(Y.encodeStateVector(doc))));
  return { doc: snapshotDoc, fixes };
}

/**
 * Track the local user's edits on `doc`. `isLocalEdit(tr)` decides which local
 * transactions are the user's own edits (not seeding or tracked-change bookkeeping).
 * Authorship across moves comes from the doc's provenance tracker (trackProvenance).
 */
export function createLocalEditTracker(
  doc: Y.Doc,
  nodes: ReadonlyArray<Klass<LexicalNode>>,
  isLocalEdit: (tr: Y.Transaction) => boolean,
): LocalEditTracker {
  const sessions = new Set<LocalEditSession>();

  const onAfterTransaction = (tr: Y.Transaction) => {
    if (sessions.size === 0 || !tr.local || !isLocalEdit(tr)) return;
    const before = tr.beforeState.get(doc.clientID) || 0;
    const after = tr.afterState.get(doc.clientID) || 0;
    for (const session of sessions) {
      if (after > before) session.inserted.push({ clock: before, len: after - before });
      if (tr.deleteSet.clients.size > 0) session.deleted.push(tr.deleteSet);
    }
  };
  doc.on('afterTransaction', onAfterTransaction);

  return {
    begin() {
      const session: LocalEditSession = { inserted: [], deleted: [], active: true };
      sessions.add(session);
      return session;
    },
    end(session) {
      session.active = false;
      sessions.delete(session);
    },
    baselineJson(session) {
      const { doc: snapshotDoc, fixes } = baselineDoc(doc, session);
      try {
        return lexicalJsonFromYDoc(snapshotDoc, nodes, fixes);
      } finally {
        snapshotDoc.destroy();
      }
    },
    currentJson() {
      return lexicalJsonFromYDoc(doc, nodes);
    },
    destroy() {
      sessions.clear();
      doc.off('afterTransaction', onAfterTransaction);
    },
  };
}
