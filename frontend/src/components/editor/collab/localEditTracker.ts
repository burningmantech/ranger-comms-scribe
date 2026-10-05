/**
 * The local user's own edits since a point in time, so a tracked change can stay open
 * while other users' edits merge in (collaborative mode).
 *
 * A tracked change's before-state is computed when it settles: the current document with
 * this user's in-progress edits taken out (their inserted Yjs items hidden, the items they
 * deleted restored). Its after-state is the current document. Both contain every edit
 * merged from other users, so the diff is exactly this user's edits, however long the
 * change stayed open.
 *
 * Requires the Y.Doc to keep deleted content (`gc: false`), so deleted text can be restored.
 */
import * as Y from 'yjs';
import { createEditor, Klass, LexicalNode } from 'lexical';
import { createBinding, Provider, syncYjsChangesToLexical } from '@lexical/yjs';

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

/** Convert a Y.Doc holding a Lexical document into Lexical JSON (headless editor, same mapping as the live editor). */
export function lexicalJsonFromYDoc(source: Y.Doc, nodes: ReadonlyArray<Klass<LexicalNode>>): string {
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
    return JSON.stringify(editor.getEditorState());
  } finally {
    shared.unobserveDeep(onEvents);
    target.destroy();
  }
}

/** `ranges` minus `remove` (both sorted, non-overlapping). */
function subtractRanges(ranges: Range[], remove: Range[]): Range[] {
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

/**
 * The document state without the session's edits, as a Yjs snapshot: every struct, but
 * the session's inserts counted as deleted and its deletions not.
 */
export function baselineDoc(doc: Y.Doc, session: Pick<LocalEditSession, 'inserted' | 'deleted'>): Y.Doc {
  const current = Y.createDeleteSetFromStructStore(doc.store);
  const mine = Y.mergeDeleteSets(session.deleted);
  const ds = Y.createDeleteSet();
  current.clients.forEach((items, client) => {
    const kept = subtractRanges(items as Range[], (mine.clients.get(client) as Range[] | undefined) || []);
    if (kept.length) ds.clients.set(client, kept as any);
  });
  if (session.inserted.length) {
    const own = (ds.clients.get(doc.clientID) as Range[] | undefined) || [];
    ds.clients.set(doc.clientID, own.concat(session.inserted) as any);
  }
  const normalized = Y.mergeDeleteSets([ds]); // sorts and merges ranges
  return Y.createDocFromSnapshot(doc, Y.createSnapshot(normalized, Y.decodeStateVector(Y.encodeStateVector(doc))));
}

/**
 * Track the local user's edits on `doc`. `isLocalEdit(tr)` decides which local
 * transactions are the user's own edits (not seeding or tracked-change bookkeeping).
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
      const snapshotDoc = baselineDoc(doc, session);
      try {
        return lexicalJsonFromYDoc(snapshotDoc, nodes);
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
