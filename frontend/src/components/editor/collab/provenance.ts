/**
 * Who really wrote each character, across moves (collaborative mode).
 *
 * @lexical/yjs syncs a structural edit by deleting the affected text and re-inserting
 * identical copies, as new Yjs items authored by whoever made the edit:
 *   - Enter (paragraph split): the text after the caret goes into a new paragraph;
 *   - format change (bold): the text node is split and the pieces re-created;
 *   - block type change (heading): the whole block is replaced;
 *   - Backspace at a paragraph start (merge): the paragraph's text is appended to the previous one.
 * So a character's Yjs client is not necessarily its author. This module watches every
 * transaction (local and remote) and, when a transaction deletes text and inserts the same
 * text, records each copy's original. `rootOf` then follows copies back to the character
 * that was actually typed, and `isMoved` tells deletions that were moves from real ones.
 * Every client sees the same transactions, so they all agree.
 *
 * Requires `gc: false` (deleted content stays readable).
 */
import * as Y from 'yjs';

export type CharKey = string; // `${client}:${clock}`

export const charKey = (client: number, clock: number): CharKey => `${client}:${clock}`;

export function parseCharKey(key: CharKey): { client: number; clock: number } {
  const i = key.indexOf(':');
  return { client: Number(key.slice(0, i)), clock: Number(key.slice(i + 1)) };
}

export interface Provenance {
  /** The originally typed character behind `key` (itself when it isn't a copy). */
  rootOf(key: CharKey): CharKey;
  /** Whether the deleted character `key` was moved (copied elsewhere), not really deleted. */
  isMoved(key: CharKey): boolean;
  /** For a container that replaced another in the same transaction (block type change): the old one. */
  replacedContainer(item: Y.Item): Y.Item | null;
  /** Whether the deleted container `item` was replaced by another (its deletion isn't a real one). */
  isReplacedContainer(item: Y.Item): boolean;
  destroy(): void;
}

interface Char {
  key: CharKey;
  char: string;
  item: Y.Item;
}

const registry = new WeakMap<Y.Doc, Provenance>();

/** The provenance tracker attached to `doc` (created by trackProvenance), if any. */
export function getProvenance(doc: Y.Doc): Provenance | null {
  return registry.get(doc) || null;
}

function stringOf(item: Y.Item): string | null {
  return item.content instanceof Y.ContentString ? ((item.content as any).str as string) : null;
}

/** Characters of `client` with clock in [from, to), from the store (no item splitting). */
function charsInRange(doc: Y.Doc, client: number, from: number, to: number, out: Char[], items: Set<Y.Item>): void {
  const structs = doc.store.clients.get(client) as Array<Y.Item | Y.GC> | undefined;
  if (!structs || from >= to) return;
  let i: number;
  try {
    i = Y.findIndexSS(structs as any, from);
  } catch {
    return;
  }
  for (; i < structs.length; i++) {
    const struct = structs[i];
    if (struct.id.clock >= to) break;
    if (!(struct instanceof Y.Item)) continue;
    items.add(struct);
    if (struct.parentSub !== null) continue;
    const str = stringOf(struct);
    if (str === null) continue;
    const start = Math.max(from, struct.id.clock);
    const end = Math.min(to, struct.id.clock + str.length);
    for (let clock = start; clock < end; clock++) {
      out.push({ key: charKey(client, clock), char: str[clock - struct.id.clock], item: struct });
    }
  }
}

/** Group characters by parent type, each group in document order. */
function byParentInOrder(chars: Char[]): Array<Char[]> {
  const byItem = new Map<Y.Item, Char[]>();
  const parents = new Set<Y.AbstractType<any>>();
  for (const c of chars) {
    const list = byItem.get(c.item) || [];
    list.push(c);
    byItem.set(c.item, list);
    parents.add(c.item.parent as Y.AbstractType<any>);
  }
  const groups: Array<Char[]> = [];
  parents.forEach((parent) => {
    const group: Char[] = [];
    for (let item = parent._start; item !== null; item = item.right) {
      const list = byItem.get(item);
      if (list) group.push(...list.sort((a, b) => parseCharKey(a.key).clock - parseCharKey(b.key).clock));
    }
    groups.push(group);
  });
  return groups;
}

/** Runs of directly adjacent inserted characters (copies are always contiguous). */
function runsOf(group: Char[]): Array<Char[]> {
  const runs: Array<Char[]> = [];
  let run: Char[] = [];
  for (let i = 0; i < group.length; i++) {
    const c = group[i];
    const prev = group[i - 1];
    const adjacent = prev && (prev.item === c.item || prev.item.right === c.item);
    if (!adjacent && run.length) {
      runs.push(run);
      run = [];
    }
    run.push(c);
  }
  if (run.length) runs.push(run);
  return runs;
}

export function trackProvenance(doc: Y.Doc): Provenance {
  const copyOf = new Map<CharKey, CharKey>();
  const moved = new Set<CharKey>();
  const replaced = new Map<Y.Item, Y.Item>(); // new container -> old
  const replacedOld = new Set<Y.Item>();

  const rootOf = (key: CharKey): CharKey => {
    let current = key;
    for (let hops = 0; hops < 1000; hops++) {
      const next = copyOf.get(current);
      if (next === undefined) return current;
      current = next;
    }
    return current;
  };

  const onAfterTransaction = (tr: Y.Transaction) => {
    if (tr.deleteSet.clients.size === 0) return;
    const inserted: Char[] = [];
    const insertedItems = new Set<Y.Item>();
    tr.afterState.forEach((after, client) => {
      const before = tr.beforeState.get(client) || 0;
      if (after > before) charsInRange(doc, client, before, after, inserted, insertedItems);
    });
    if (insertedItems.size === 0) return;
    const deleted: Char[] = [];
    const deletedItems = new Set<Y.Item>();
    tr.deleteSet.clients.forEach((ranges, client) => {
      for (const r of ranges as Array<{ clock: number; len: number }>) {
        charsInRange(doc, client, r.clock, r.clock + r.len, deleted, deletedItems);
      }
    });

    // Text moves: an inserted run identical to deleted text in this transaction.
    if (deleted.length && inserted.length) {
      const sources = byParentInOrder(deleted).map((group) => ({ group, text: group.map((c) => c.char).join(''), used: new Array(group.length).fill(false) }));
      for (const group of byParentInOrder(inserted)) {
        for (const run of runsOf(group)) {
          const text = run.map((c) => c.char).join('');
          for (const source of sources) {
            let from = 0;
            let idx = -1;
            for (;;) {
              idx = source.text.indexOf(text, from);
              if (idx === -1) break;
              if (!source.used.slice(idx, idx + text.length).some(Boolean)) break;
              from = idx + 1;
            }
            if (idx === -1) continue;
            run.forEach((c, k) => {
              const original = source.group[idx + k];
              source.used[idx + k] = true;
              copyOf.set(c.key, rootOf(original.key));
              moved.add(original.key);
            });
            break;
          }
        }
      }
    }

    // Container replacements (block type change): a new block next to a block deleted in
    // the same transaction, under the same parent.
    insertedItems.forEach((item) => {
      if (!(item.content instanceof Y.ContentType) || item.parentSub !== null) return;
      if (!((item.content as any).type instanceof Y.XmlText)) return;
      const neighbours = [item.left, item.right];
      for (const n of neighbours) {
        if (n && deletedItems.has(n) && n.parent === item.parent && n.content instanceof Y.ContentType &&
            (n.content as any).type instanceof Y.XmlText && !replacedOld.has(n)) {
          replaced.set(item, n);
          replacedOld.add(n);
          return;
        }
      }
    });
  };
  doc.on('afterTransaction', onAfterTransaction);

  const provenance: Provenance = {
    rootOf,
    isMoved: (key) => moved.has(key),
    replacedContainer: (item) => replaced.get(item) || null,
    isReplacedContainer: (item) => replacedOld.has(item),
    destroy() {
      doc.off('afterTransaction', onAfterTransaction);
      registry.delete(doc);
    },
  };
  registry.set(doc, provenance);
  return provenance;
}
