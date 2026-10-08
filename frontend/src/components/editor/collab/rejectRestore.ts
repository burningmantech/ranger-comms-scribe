/**
 * Reject a tracked change by context (collaborative mode).
 *
 * A change record carries the whole document before (`richTextOldValue`) and after
 * (`richTextNewValue`) the edit. Rejecting it applies the patch "after -> before" to the
 * live document, which may have moved on since (other users' edits, other rejects):
 *
 *   1. Every document is flattened to a sequence of units: one unit per top-level block
 *      (its type and attributes), one per character of text (with its format, style and
 *      enclosing link), one per inline leaf (line break, tab, image, deletion marker).
 *      Lists, tables and other non-text blocks are one opaque unit each.
 *   2. patch = diff(after, before): the hunks the change made.
 *      alignment = diff(after, live): where each unit of the change's after-state is now.
 *      Both diffs run on blocks first, then on the units of the blocks that differ.
 *   3. Each hunk is mapped through the alignment into the live document. An exact match
 *      (the hunk's units are all still there, contiguous) is used as is; small edits
 *      around or inside it are tolerated within thresholds; anything else fails.
 *   4. The live units with the hunks replaced are rebuilt into blocks, and only the
 *      top-level blocks that differ from the live ones are replaced.
 *
 * Everything here works on serialized Lexical JSON, so it runs without an editor or DOM.
 * `$rejectByContext` applies a plan inside an editor update.
 */
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $parseSerializedNode,
  $setSelection,
  LexicalNode,
  SerializedLexicalNode,
} from 'lexical';

type Json = any;

/** Top-level blocks whose children are inline content (text, links, line breaks, images). */
const TEXT_BLOCK_TYPES = new Set(['paragraph', 'heading', 'quote', 'code']);

/** Properties that differ between equal documents (computed or editor-local), never compared. */
const IGNORED_PROPS = new Set(['direction', 'textFormat', 'textStyle', 'version', 'detail']);

/** Deletion-marker properties that change after creation (rename on save, display, the creator's key). */
const IGNORED_MARKER_PROPS = new Set(['changeId', 'authorName', 'authorColor', 'pendingKey']);

/** Units of context on each side of a hunk used to check its location. */
const CONTEXT_UNITS = 24;
/** Minimum share of the context around a hunk that must still be where it was. */
const MIN_ANCHOR_SCORE = 0.6;
/** Minimum similarity between the change's text and the live text it maps to. */
const MIN_CONTENT_SIMILARITY = 0.6;
/** A hunk this long whose units are all present, in place, needs no context check. */
const SELF_ANCHORED_UNITS = 8;
/** Live text at a restore point this similar to the text being restored means it is already back. */
const ALREADY_RESTORED_SIMILARITY = 0.8;
/** Edit distance above which a unit-level diff gives up and treats the run as replaced. */
const MAX_DIFF_DISTANCE = 2000;

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

type UnitKind = 'block' | 'opaque' | 'char' | 'leaf';

interface Unit {
  id: number;
  kind: UnitKind;
  /** block: the block without children; opaque/leaf: the whole node; char: the text node without text. */
  node: Json;
  /** char only. */
  ch?: string;
  /** char only: identity of the text node's properties, for regrouping characters. */
  textKey?: string;
  /** Inline elements (links) around this unit, outermost first, without children. */
  wrappers: Json[];
  wrapperKeys: string[];
  /** A deletion marker (DeletedTextNode): aligned like any unit, never restored. */
  marker?: boolean;
}

interface DocUnits {
  units: Unit[];
  /** Unit index where each top-level block starts, plus the total length at the end. */
  blockStart: number[];
  /** Interned identity of each top-level block (all its unit ids). */
  blockIds: number[];
}

class Interner {
  private ids = new Map<string, number>();
  id(key: string): number {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.ids.size;
      this.ids.set(key, id);
    }
    return id;
  }
}

/** Stable JSON of a node's compared properties (sorted keys, ignored props dropped, recursive). */
function canon(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  const isMarker = value.type === 'deleted-text';
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined && !IGNORED_PROPS.has(k) && !(isMarker && IGNORED_MARKER_PROPS.has(k)))
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}

function withoutChildren(node: Json): Json {
  const { children, ...rest } = node || {};
  return rest;
}

function withoutText(node: Json): Json {
  const { text, ...rest } = node || {};
  return rest;
}

function toUnits(blocks: Json[], interner: Interner): DocUnits {
  const units: Unit[] = [];
  const blockStart: number[] = [];
  const blockIds: number[] = [];

  const push = (u: Omit<Unit, 'id'>, key: string) => {
    units.push({ ...u, id: interner.id(key) });
  };

  const inline = (nodes: Json[], wrappers: Json[], wrapperKeys: string[]) => {
    const wk = wrapperKeys.join('\u0001');
    for (const n of nodes || []) {
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n.children)) {
        const w = withoutChildren(n);
        inline(n.children, [...wrappers, w], [...wrapperKeys, canon(w)]);
      } else if (n.type === 'text' && typeof n.text === 'string') {
        const props = withoutText(n);
        const textKey = canon(props);
        for (const ch of Array.from(n.text as string)) {
          push({ kind: 'char', node: props, ch, textKey, wrappers, wrapperKeys }, 'c' + ch + '\u0000' + textKey + '\u0000' + wk);
        }
      } else {
        const marker = n.type === 'deleted-text';
        push({ kind: 'leaf', node: n, wrappers, wrapperKeys, marker }, 'l' + canon(n) + '\u0000' + wk);
      }
    }
  };

  for (const block of blocks || []) {
    const start = units.length;
    blockStart.push(start);
    if (block && TEXT_BLOCK_TYPES.has(block.type) && Array.isArray(block.children)) {
      const node = withoutChildren(block);
      push({ kind: 'block', node, wrappers: [], wrapperKeys: [] }, 'b' + canon(node));
      inline(block.children, [], []);
    } else {
      push({ kind: 'opaque', node: block, wrappers: [], wrapperKeys: [], marker: block?.type === 'deleted-text' }, 'o' + canon(block));
    }
    blockIds.push(interner.id(units.slice(start).map((u) => u.id).join(',')));
  }
  blockStart.push(units.length);
  return { units, blockStart, blockIds };
}

// ---------------------------------------------------------------------------
// Diff (Myers, on integer sequences; blocks first, then units)
// ---------------------------------------------------------------------------

interface Op {
  type: 'equal' | 'delete' | 'insert';
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

function pushOp(ops: Op[], type: Op['type'], a0: number, a1: number, b0: number, b1: number): void {
  if (a1 === a0 && b1 === b0) return;
  const last = ops[ops.length - 1];
  if (last && last.type === type && last.a1 === a0 && last.b1 === b0) {
    last.a1 = a1;
    last.b1 = b1;
    return;
  }
  ops.push({ type, a0, a1, b0, b1 });
}

/** Diff a[a0..a1) against b[b0..b1). Returns ops in a and b coordinates. */
function diffRange(a: number[], a0: number, a1: number, b: number[], b0: number, b1: number): Op[] {
  const ops: Op[] = [];
  let s = 0;
  while (a0 + s < a1 && b0 + s < b1 && a[a0 + s] === b[b0 + s]) s++;
  let e = 0;
  while (a1 - e > a0 + s && b1 - e > b0 + s && a[a1 - e - 1] === b[b1 - e - 1]) e++;
  pushOp(ops, 'equal', a0, a0 + s, b0, b0 + s);
  const ma0 = a0 + s;
  const ma1 = a1 - e;
  const mb0 = b0 + s;
  const mb1 = b1 - e;
  if (ma0 === ma1 || mb0 === mb1) {
    pushOp(ops, 'delete', ma0, ma1, mb0, mb0);
    pushOp(ops, 'insert', ma1, ma1, mb0, mb1);
  } else {
    for (const op of myers(a, ma0, ma1, b, mb0, mb1)) pushOp(ops, op.type, op.a0, op.a1, op.b0, op.b1);
  }
  pushOp(ops, 'equal', a1 - e, a1, b1 - e, b1);
  return ops;
}

function myers(a: number[], a0: number, a1: number, b: number[], b0: number, b1: number): Op[] {
  const N = a1 - a0;
  const M = b1 - b0;
  const max = Math.min(N + M, MAX_DIFF_DISTANCE);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let finalD = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2)); // k = -d-1 .. d+1
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        finalD = d;
        break outer;
      }
    }
  }
  if (finalD < 0) {
    // Too different: treat the whole range as replaced.
    return [
      { type: 'delete', a0, a1, b0, b1: b0 },
      { type: 'insert', a0: a1, a1, b0, b1 },
    ];
  }
  const rev: Op[] = [];
  let x = N;
  let y = M;
  for (let d = finalD; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const sx = down ? prevX : prevX + 1;
    const sy = sx - k;
    if (x > sx) rev.push({ type: 'equal', a0: a0 + sx, a1: a0 + x, b0: b0 + sy, b1: b0 + y });
    if (down) rev.push({ type: 'insert', a0: a0 + prevX, a1: a0 + prevX, b0: b0 + prevY, b1: b0 + prevY + 1 });
    else rev.push({ type: 'delete', a0: a0 + prevX, a1: a0 + prevX + 1, b0: b0 + prevY, b1: b0 + prevY });
    x = prevX;
    y = prevY;
  }
  if (x > 0) rev.push({ type: 'equal', a0, a1: a0 + x, b0, b1: b0 + y });
  const ops: Op[] = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const o = rev[i];
    pushOp(ops, o.type, o.a0, o.a1, o.b0, o.b1);
  }
  return ops;
}

/** Unit-level diff of two documents: blocks first, then the units of differing block runs. */
function diffDocs(A: DocUnits, B: DocUnits): Op[] {
  const aIds = A.units.map((u) => u.id);
  const bIds = B.units.map((u) => u.id);
  const blockOps = diffRange(A.blockIds, 0, A.blockIds.length, B.blockIds, 0, B.blockIds.length);
  const ops: Op[] = [];
  let i = 0;
  while (i < blockOps.length) {
    const op = blockOps[i];
    if (op.type === 'equal') {
      pushOp(ops, 'equal', A.blockStart[op.a0], A.blockStart[op.a1], B.blockStart[op.b0], B.blockStart[op.b1]);
      i++;
      continue;
    }
    // A run of differing blocks: diff their units.
    const ba0 = op.a0;
    const bb0 = op.b0;
    let ba1 = op.a1;
    let bb1 = op.b1;
    i++;
    while (i < blockOps.length && blockOps[i].type !== 'equal') {
      ba1 = blockOps[i].a1;
      bb1 = blockOps[i].b1;
      i++;
    }
    const sub = diffRange(aIds, A.blockStart[ba0], A.blockStart[ba1], bIds, B.blockStart[bb0], B.blockStart[bb1]);
    for (const o of sub) pushOp(ops, o.type, o.a0, o.a1, o.b0, o.b1);
  }
  return ops;
}

interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

function hunksOf(ops: Op[]): Hunk[] {
  const hunks: Hunk[] = [];
  for (const op of ops) {
    if (op.type === 'equal') continue;
    const last = hunks[hunks.length - 1];
    if (last && last.a1 === op.a0 && last.b1 === op.b0) {
      last.a1 = op.a1;
      last.b1 = op.b1;
    } else {
      hunks.push({ a0: op.a0, a1: op.a1, b0: op.b0, b1: op.b1 });
    }
  }
  return hunks;
}

/** 2 * matches / (len a + len b) of two unit-id sequences (1 for two empty ones). */
function similarity(a: number[], b: number[]): number {
  if (a.length + b.length === 0) return 1;
  let matches = 0;
  for (const op of diffRange(a, 0, a.length, b, 0, b.length)) {
    if (op.type === 'equal') matches += op.a1 - op.a0;
  }
  return (2 * matches) / (a.length + b.length);
}

// ---------------------------------------------------------------------------
// Rebuilding blocks from units
// ---------------------------------------------------------------------------

const DEFAULT_PARAGRAPH: Json = {
  type: 'paragraph',
  direction: null,
  format: '',
  indent: 0,
  textFormat: 0,
  textStyle: '',
  version: 1,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function buildInline(units: Unit[], depth: number): Json[] {
  const out: Json[] = [];
  let i = 0;
  while (i < units.length) {
    const u = units[i];
    if (u.wrappers.length > depth) {
      const key = u.wrapperKeys[depth];
      let j = i;
      while (j < units.length && units[j].wrappers.length > depth && units[j].wrapperKeys[depth] === key) j++;
      out.push({ ...clone(u.wrappers[depth]), children: buildInline(units.slice(i, j), depth + 1) });
      i = j;
    } else if (u.kind === 'char') {
      let text = '';
      let j = i;
      while (j < units.length && units[j].kind === 'char' && units[j].wrappers.length === depth && units[j].textKey === u.textKey) {
        text += units[j].ch;
        j++;
      }
      out.push({ ...clone(u.node), text });
      i = j;
    } else {
      out.push(clone(u.node));
      i++;
    }
  }
  return out;
}

interface RebuiltBlock {
  units: Unit[];
}

/** Split a unit sequence into top-level blocks (inline units with no block get a paragraph). */
function segmentBlocks(units: Unit[], interner: Interner): RebuiltBlock[] {
  const blocks: RebuiltBlock[] = [];
  let current: RebuiltBlock | null = null;
  for (const u of units) {
    if (u.kind === 'block') {
      current = { units: [u] };
      blocks.push(current);
    } else if (u.kind === 'opaque') {
      blocks.push({ units: [u] });
      current = null;
    } else {
      if (!current) {
        const p: Unit = { id: interner.id('b' + canon(DEFAULT_PARAGRAPH)), kind: 'block', node: DEFAULT_PARAGRAPH, wrappers: [], wrapperKeys: [] };
        current = { units: [p] };
        blocks.push(current);
      }
      current.units.push(u);
    }
  }
  return blocks;
}

function blockToJson(block: RebuiltBlock): Json {
  const [head, ...rest] = block.units;
  if (head.kind === 'opaque') return clone(head.node);
  return { ...clone(head.node), children: buildInline(rest, 0) };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Replace live top-level blocks [start, start + deleteCount) with `nodes`. */
export interface BlockReplacement {
  start: number;
  deleteCount: number;
  nodes: SerializedLexicalNode[];
}

export type RejectRestorePlan =
  | { ok: true; replacements: BlockReplacement[] }
  | { ok: false; reason: string };

interface Splice {
  ls: number;
  le: number;
  units: Unit[];
}

function blocksOf(doc: Json): Json[] | null {
  const parsed = typeof doc === 'string' ? safeParse(doc) : doc;
  const children = parsed?.root?.children;
  return Array.isArray(children) ? children : null;
}

function safeParse(s: string): Json {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export interface PlanOptions {
  /**
   * Restore deletion markers too (normally they are never restored), with a marker that
   * still has the placeholder id `__pending_deletion__` given this change id. Used when a
   * rejected change is re-applied (undo of a reject) in collaborative mode, so its
   * deletion shows again as a marker that belongs to it.
   */
  markerChangeId?: string;
  /**
   * The other half of a move (its whole document before and after). Once that half is
   * rejected its text is back where it was cut, and that live text is the partner's, not
   * this change's text moved elsewhere: it is left out of the alignment. So an insertion
   * whose own text is gone is found already reverted (rejecting it changes nothing), and
   * is never matched to the partner's restored copy (which the reject would then remove).
   */
  movePartner?: { before: Json; after: Json };
}

/**
 * A live range [ls, le) a hunk maps to; `restored`: removed text someone has put back;
 * `reverted`: added text already reverted (the range holds the old text).
 */
interface Span {
  ls: number;
  le: number;
  restored?: boolean;
  reverted?: boolean;
}

/** Where each hunk of a change maps in the live document (unit indexes), plus the edits. */
type PatchMapping =
  | { ok: true; splices: Splice[]; spans: Span[] }
  | { ok: false; reason: string };

/**
 * Map the patch "after -> before" of a change into the live document: for every hunk, the
 * live range it occupies (`spans`) and the edit that reverts it (`splices`). This is the
 * locator shared by the reject (planRejectRestore) and by `locateChange`.
 */
function mapPatch(O: DocUnits, N: DocUnits, L: DocUnits, options: PlanOptions = {}, masked: Span[] = []): PatchMapping {
  const patch = hunksOf(diffDocs(N, O));
  const spans: Span[] = [];
  if (patch.length === 0) return { ok: true, splices: [], spans };

  const img = new Int32Array(N.units.length).fill(-1);
  const alignment = diffDocs(N, L);
  for (const op of alignment) {
    if (op.type !== 'equal') continue;
    for (let k = 0; k < op.a1 - op.a0; k++) img[op.a0 + k] = op.b0 + k;
  }
  // Live text that isn't in the change's after-state (others' edits, moved text), except
  // a move partner's restored text (masked: never aligned, never this change's text).
  const liveInserts = hunksOf(alignment).filter((x) => x.b1 > x.b0 &&
    !masked.some((m) => x.b0 < m.le && m.ls < x.b1));

  const nIds = N.units.map((u) => u.id);
  const lIds = L.units.map((u) => u.id);
  const nLen = N.units.length;
  const lLen = L.units.length;

  const leftAnchor = (p: number) => {
    for (let i = p - 1; i >= 0; i--) if (img[i] >= 0) return i;
    return -1;
  };
  const rightAnchor = (p: number) => {
    for (let i = p; i < nLen; i++) if (img[i] >= 0) return i;
    return nLen;
  };
  const anchorScore = (a0: number, a1: number) => {
    let aligned = 0;
    let total = 0;
    for (let i = Math.max(0, a0 - CONTEXT_UNITS); i < a0; i++, total++) if (img[i] >= 0) aligned++;
    for (let i = a1; i < Math.min(nLen, a1 + CONTEXT_UNITS); i++, total++) if (img[i] >= 0) aligned++;
    return total === 0 ? 1 : aligned / total;
  };

  const restoreUnits = (h: Hunk): Unit[] => {
    const units = O.units.slice(h.b0, h.b1);
    if (options.markerChangeId === undefined) return units.filter((u) => !u.marker);
    return units.map((u) => (u.marker && u.node?.changeId === '__pending_deletion__'
      ? { ...u, node: { ...u.node, changeId: options.markerChangeId } }
      : u));
  };

  const splices: Splice[] = [];
  for (const h of patch) {
    const restore = restoreUnits(h);
    const la = leftAnchor(h.a0);
    const ra = rightAnchor(h.a1);
    const laEnd = la >= 0 ? img[la] + 1 : 0;
    const raStart = ra < nLen ? img[ra] : lLen;

    if (h.a1 === h.a0) {
      // The change removed these units: put them back between their neighbours.
      if (anchorScore(h.a0, h.a1) < MIN_ANCHOR_SCORE) {
        return { ok: false, reason: 'the text around a removed passage has changed' };
      }
      let at: number;
      if (h.a0 > 0 && img[h.a0 - 1] >= 0) at = img[h.a0 - 1] + 1;
      else if (h.a0 < nLen && img[h.a0] >= 0) at = img[h.a0];
      else at = laEnd;
      const between = lIds.slice(laEnd, raStart);
      if (between.length > 0 && restore.length > 0 &&
          similarity(between, restore.map((u) => u.id)) >= ALREADY_RESTORED_SIMILARITY) {
        spans.push({ ls: laEnd, le: raStart, restored: true });
        continue; // someone has put it back already
      }
      spans.push({ ls: at, le: at });
      if (restore.length > 0) splices.push({ ls: at, le: at, units: restore });
      continue;
    }

    // The change added or replaced units [a0, a1): find them in the live document.
    let matched = 0;
    for (let i = h.a0; i < h.a1; i++) if (img[i] >= 0) matched++;
    const ls = img[h.a0] >= 0 ? img[h.a0] : laEnd;
    const le = img[h.a1 - 1] >= 0 ? img[h.a1 - 1] + 1 : raStart;
    if (le < ls) return { ok: false, reason: 'the changed text could not be located' };
    const span = h.a1 - h.a0;
    const exact = matched === span && le - ls === span;
    if (!(exact && span >= SELF_ANCHORED_UNITS)) {
      if (anchorScore(h.a0, h.a1) < MIN_ANCHOR_SCORE) {
        return { ok: false, reason: 'the text around the change has changed' };
      }
    }
    if (!exact) {
      const sim = (2 * matched) / (span + (le - ls));
      if (sim < MIN_CONTENT_SIMILARITY) {
        // Already reverted (by hand, or by rejecting a change it depended on): the live
        // text between the anchors is the old text.
        if (matched * 2 < span && anchorScore(h.a0, h.a1) >= MIN_ANCHOR_SCORE &&
            similarity(lIds.slice(laEnd, raStart), restore.map((u) => u.id)) >= ALREADY_RESTORED_SIMILARITY) {
          // ... unless the text was moved, not removed: then it is somewhere else now.
          const added = nIds.slice(h.a0, h.a1);
          const movedTo = liveInserts.find((x) => x.b1 - x.b0 >= added.length / 2 && x.b1 - x.b0 <= added.length * 2 &&
            similarity(lIds.slice(x.b0, x.b1), added) >= MIN_CONTENT_SIMILARITY);
          if (movedTo) return { ok: false, reason: 'the changed text has been moved since' };
          spans.push({ ls: laEnd, le: raStart, reverted: true });
          continue;
        }
        return { ok: false, reason: 'the changed text has been edited or removed since' };
      }
    }
    spans.push({ ls, le });
    splices.push({ ls, le, units: restore });
  }

  // Splices are in document order (the alignment is monotonic); refuse overlaps.
  splices.sort((x, y) => x.ls - y.ls || x.le - y.le);
  for (let i = 1; i < splices.length; i++) {
    if (splices[i].ls < splices[i - 1].le) return { ok: false, reason: 'the change overlaps itself in the document' };
  }
  return { ok: true, splices, spans };
}

/**
 * Plan the reject of a change (before -> after) against the live document's top-level
 * blocks. `before` and `after` are Lexical editor-state JSON (string or object).
 *
 * Swapping `before` and `after` plans the opposite: re-applying a change that was
 * rejected (see planReapply).
 */
export function planRejectRestore(before: Json, after: Json, liveBlocks: Json[], options: PlanOptions = {}): RejectRestorePlan {
  const oldBlocks = blocksOf(before);
  const newBlocks = blocksOf(after);
  if (!oldBlocks || !newBlocks) return { ok: false, reason: 'the change has no rich text' };

  const interner = new Interner();
  const O = toUnits(oldBlocks, interner);
  const N = toUnits(newBlocks, interner);
  const L = toUnits(liveBlocks, interner);

  // A move partner's restored text is left out of the alignment (same unit indexes).
  const masked = options.movePartner ? partnerRestoredSpans(options.movePartner, L, interner) : [];
  const mapping = mapPatch(O, N, masked.length > 0 ? maskUnits(L, masked, interner) : L, options, masked);
  if (!mapping.ok) return mapping;
  const { splices } = mapping;
  if (splices.length === 0) return { ok: true, replacements: [] };

  const result: Unit[] = [];
  let pos = 0;
  for (const s of splices) {
    result.push(...L.units.slice(pos, s.ls), ...s.units);
    pos = s.le;
  }
  result.push(...L.units.slice(pos));

  const rebuilt = segmentBlocks(result, interner);
  if (rebuilt.length === 0) {
    // A document always keeps one block.
    rebuilt.push({ units: [{ id: interner.id('b' + canon(DEFAULT_PARAGRAPH)), kind: 'block', node: DEFAULT_PARAGRAPH, wrappers: [], wrapperKeys: [] }] });
  }
  const rebuiltIds = rebuilt.map((b) => interner.id(b.units.map((u) => u.id).join(',')));

  const replacements: BlockReplacement[] = [];
  const ops = diffRange(L.blockIds, 0, L.blockIds.length, rebuiltIds, 0, rebuiltIds.length);
  for (const op of ops) {
    if (op.type === 'equal') continue;
    const last = replacements[replacements.length - 1];
    const nodes = rebuilt.slice(op.b0, op.b1).map(blockToJson);
    if (last && last.start + last.deleteCount === op.a0) {
      last.deleteCount += op.a1 - op.a0;
      last.nodes.push(...nodes);
    } else {
      replacements.push({ start: op.a0, deleteCount: op.a1 - op.a0, nodes });
    }
  }
  return { ok: true, replacements };
}

/**
 * Where a move partner (the other half of a move) has had its removed text put back in
 * the live document: the live ranges of its removal hunks found already restored. Empty
 * when the partner is pending (its text is still cut) or can't be located.
 */
function partnerRestoredSpans(partner: { before: Json; after: Json }, L: DocUnits, interner: Interner): Span[] {
  const oldBlocks = blocksOf(partner.before);
  const newBlocks = blocksOf(partner.after);
  if (!oldBlocks || !newBlocks) return [];
  const mapping = mapPatch(toUnits(oldBlocks, interner), toUnits(newBlocks, interner), L);
  if (!mapping.ok) return [];
  return mapping.spans.filter((x) => x.restored && x.le > x.ls);
}

/** A copy of `L` whose units in `spans` match nothing (unique ids), for the alignment. */
function maskUnits(L: DocUnits, spans: Span[], interner: Interner): DocUnits {
  const units = L.units.map((u, i) => (spans.some((x) => i >= x.ls && i < x.le)
    ? { ...u, id: interner.id(`\u0002masked\u0000${i}`) }
    : u));
  const blockIds = L.blockIds.map((_, b) =>
    interner.id(units.slice(L.blockStart[b], L.blockStart[b + 1]).map((u) => u.id).join(',')));
  return { units, blockStart: L.blockStart, blockIds };
}

/** Apply a plan to serialized top-level blocks (pure; mirrors `$rejectByContext`). */
export function applyBlockReplacements(liveBlocks: Json[], replacements: BlockReplacement[]): Json[] {
  const out = [...liveBlocks];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    out.splice(r.start, r.deleteCount, ...r.nodes);
  }
  return out;
}

/** The top-level block replacements that turn `from` into `to` (blocks compared like units). */
function blockReplacementsBetween(from: Json[], to: Json[]): BlockReplacement[] {
  const interner = new Interner();
  const a = from.map((x) => interner.id(canon(x)));
  const b = to.map((x) => interner.id(canon(x)));
  const replacements: BlockReplacement[] = [];
  for (const op of diffRange(a, 0, a.length, b, 0, b.length)) {
    if (op.type === 'equal') continue;
    const last = replacements[replacements.length - 1];
    const nodes = to.slice(op.b0, op.b1).map((n) => clone(n));
    if (last && last.start + last.deleteCount === op.a0) {
      last.deleteCount += op.a1 - op.a0;
      last.nodes.push(...nodes);
    } else {
      replacements.push({ start: op.a0, deleteCount: op.a1 - op.a0, nodes });
    }
  }
  return replacements;
}

// ---------------------------------------------------------------------------
// Re-applying rejected changes (undo of a reject)
// ---------------------------------------------------------------------------

/** A change record: its whole document before and after the edit (Lexical JSON). */
export interface ChangeDocs {
  id?: string;
  before: Json;
  after: Json;
}

/**
 * Plan re-applying changes that were rejected (an undo of the reject): each change's patch
 * "before -> after" is located in the live document with the same locator as a reject
 * (planRejectRestore with the two documents swapped) and applied, in the order given (pass
 * them oldest first, the reverse of how a reject cascade reverts them). All or nothing: if
 * one change can't be located, the plan fails and nothing is to change.
 *
 * `keepMarkers` (collaborative mode) also puts back the change's own deletion markers, so
 * a re-applied deletion shows as one again.
 */
export function planReapply(changes: ChangeDocs[], liveBlocks: Json[], options: { keepMarkers?: boolean } = {}): RejectRestorePlan {
  let blocks = liveBlocks;
  for (const change of changes) {
    const plan = planRejectRestore(change.after, change.before, blocks,
      options.keepMarkers ? { markerChangeId: change.id ?? '__pending_deletion__' } : {});
    if (!plan.ok) return plan;
    blocks = applyBlockReplacements(blocks, plan.replacements);
  }
  return { ok: true, replacements: blockReplacementsBetween(liveBlocks, blocks) };
}

// ---------------------------------------------------------------------------
// Locating a change in the live document
// ---------------------------------------------------------------------------

/** A point in the live document: a top-level block and a unit offset inside it. */
export interface UnitPoint {
  block: number;
  /** Units after the block's own unit (characters, inline leaves); 0 for an opaque block. */
  offset: number;
}

export interface ChangeLocation {
  /** Global unit index of the start, for ordering changes by document position. */
  order: number;
  start: UnitPoint;
  /** Exclusive end. */
  end: UnitPoint;
  /** Nothing of the change is in the document (a pure deletion): start is where it was. */
  collapsed: boolean;
}

/**
 * Where a change is in the live document, found with the same locator as a reject
 * (mapPatch). For a deletion the location is collapsed at the point the text was removed
 * from. Null when the change can't be located (or has no rich text).
 */
export function locateChange(before: Json, after: Json, liveBlocks: Json[]): ChangeLocation | null {
  const oldBlocks = blocksOf(before);
  const newBlocks = blocksOf(after);
  if (!oldBlocks || !newBlocks || !Array.isArray(liveBlocks) || liveBlocks.length === 0) return null;
  const interner = new Interner();
  const O = toUnits(oldBlocks, interner);
  const N = toUnits(newBlocks, interner);
  const L = toUnits(liveBlocks, interner);
  const mapping = mapPatch(O, N, L);
  if (!mapping.ok || mapping.spans.length === 0) return null;
  const ls = Math.min(...mapping.spans.map((s) => s.ls));
  const le = Math.max(...mapping.spans.map((s) => s.le));
  const blockOf = (pos: number) => {
    let block = 0;
    while (block + 1 < liveBlocks.length && L.blockStart[block + 1] <= pos) block++;
    return block;
  };
  const inlineStart = (block: number) => {
    const first = L.blockStart[block];
    return L.units[first]?.kind === 'block' ? first + 1 : first;
  };
  const startBlock = blockOf(ls);
  const start = { block: startBlock, offset: Math.max(0, ls - inlineStart(startBlock)) };
  const collapsed = le <= ls;
  if (collapsed) return { order: ls, start, end: start, collapsed };
  const endBlock = blockOf(le - 1);
  return { order: ls, start, end: { block: endBlock, offset: Math.max(0, le - inlineStart(endBlock)) }, collapsed };
}

/** Text length of a node as the decorations count it: its text nodes, deletion markers left out. */
function plainTextLength(node: Json): number {
  if (!node || typeof node !== 'object' || node.type === 'deleted-text') return 0;
  let length = typeof node.text === 'string' ? node.text.length : 0;
  if (Array.isArray(node.children)) for (const child of node.children) length += plainTextLength(child);
  return length;
}

function unitTextLength(u: Unit): number {
  if (u.kind === 'char') return u.ch!.length;
  if (u.kind === 'block') return 0;
  return plainTextLength(u.node); // a leaf (a tab is text) or an opaque block (all its text)
}

/**
 * The text a change put into the live document (what it inserted, or replaced text with),
 * located with the same locator as a reject, so it is found wherever the document has
 * moved on since: other changes made, rejected or undone around it. Ranges are offsets in
 * the live document's plain text: the text of its text nodes, top-level block after block,
 * deletion markers left out (TrackedChangesPlugin's "clean text"). Empty for a pure
 * deletion; null when the change can't be located (or has no rich text), or is inside a
 * list, table or code token (one unit here, so not located to the character).
 */
export function locateChangeText(before: Json, after: Json, liveBlocks: Json[]): Array<{ start: number; end: number }> | null {
  const oldBlocks = blocksOf(before);
  const newBlocks = blocksOf(after);
  if (!oldBlocks || !newBlocks || !Array.isArray(liveBlocks)) return null;
  const interner = new Interner();
  const O = toUnits(oldBlocks, interner);
  const N = toUnits(newBlocks, interner);
  const L = toUnits(liveBlocks, interner);
  const mapping = mapPatch(O, N, L);
  if (!mapping.ok) return null;
  const offsets: number[] = new Array(L.units.length + 1);
  let pos = 0;
  for (let i = 0; i < L.units.length; i++) {
    offsets[i] = pos;
    pos += unitTextLength(L.units[i]);
  }
  offsets[L.units.length] = pos;
  const spans = mapping.spans.filter((s) => !s.restored && !s.reverted && s.le > s.ls);
  // A span over an opaque block (a list, a table) or a multi-character leaf (a code token)
  // would cover all of its text, not just what the change added: not located at the
  // character level.
  for (const s of spans) {
    for (let i = s.ls; i < s.le; i++) {
      const u = L.units[i];
      if (u.kind === 'opaque' || (u.kind === 'leaf' && unitTextLength(u) > 1)) return null;
    }
  }
  return spans
    .map((s) => ({ start: offsets[s.ls], end: offsets[s.le] }))
    .filter((r) => r.end > r.start);
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** Serialize a live node with its children (EditorState.toJSON does the same). */
export function $exportNodeJSON(node: LexicalNode): Json {
  const json: Json = node.exportJSON();
  if ($isElementNode(node)) json.children = node.getChildren().map($exportNodeJSON);
  return json;
}

export type RejectByContextResult = { ok: true; changed: boolean } | { ok: false; reason: string };

/** Replace top-level blocks per the plan in the current editor update. */
function $applyReplacements(replacements: BlockReplacement[]): RejectByContextResult {
  if (replacements.length === 0) return { ok: true, changed: false };
  const root = $getRoot();
  let built: Array<{ start: number; deleteCount: number; nodes: LexicalNode[] }>;
  try {
    built = replacements.map((r) => ({
      start: r.start,
      deleteCount: r.deleteCount,
      nodes: r.nodes.map((n) => $parseSerializedNode(n)),
    }));
  } catch (err) {
    return { ok: false, reason: `the original content could not be rebuilt (${(err as Error)?.message || err})` };
  }

  for (let i = built.length - 1; i >= 0; i--) {
    const r = built[i];
    root.splice(r.start, r.deleteCount, r.nodes);
  }

  const selection = $getSelection();
  if ($isRangeSelection(selection) &&
      (!selection.anchor.getNode().isAttached() || !selection.focus.getNode().isAttached())) {
    $setSelection(null);
  }
  return { ok: true, changed: true };
}

/**
 * Reject a change by context inside an editor update: plan against the current (pending)
 * tree, then replace only the top-level blocks that differ. Changes nothing on failure.
 */
export function $rejectByContext(before: Json, after: Json, options: PlanOptions = {}): RejectByContextResult {
  const live = $getRoot().getChildren().map($exportNodeJSON);
  const plan = planRejectRestore(before, after, live, options);
  if (!plan.ok) return plan;
  return $applyReplacements(plan.replacements);
}

/**
 * Re-apply rejected changes inside an editor update (undo of a reject), oldest first. Only
 * the top-level blocks that differ are replaced; nothing changes if any change can't be
 * located.
 */
export function $reapplyByContext(changes: ChangeDocs[], options: { keepMarkers?: boolean } = {}): RejectByContextResult {
  const live = $getRoot().getChildren().map($exportNodeJSON);
  const plan = planReapply(changes, live, options);
  if (!plan.ok) return plan;
  return $applyReplacements(plan.replacements);
}

/** A Lexical point for a unit point: a text node and offset, or a node (opaque block, leaf). */
export type LexicalUnitPoint =
  | { type: 'text'; key: string; offset: number }
  | { type: 'node'; key: string };

/**
 * Resolve a unit point (from locateChange) in the live tree, walking the block the same
 * way as the unit model: characters of text nodes (code points), inline leaves, and the
 * children of inline elements (links). Read-only; call inside a read or an update.
 */
export function $resolveUnitPoint(point: UnitPoint): LexicalUnitPoint | null {
  const block = $getRoot().getChildAtIndex(point.block);
  if (!block) return null;
  if (!(TEXT_BLOCK_TYPES.has(block.getType()) && $isElementNode(block))) return { type: 'node', key: block.getKey() };
  let remaining = point.offset;
  let lastText: LexicalUnitPoint | null = null;
  const walk = (nodes: LexicalNode[]): LexicalUnitPoint | null => {
    for (const n of nodes) {
      if ($isElementNode(n)) {
        const found = walk(n.getChildren());
        if (found) return found;
        continue;
      }
      if (n.getType() === 'text') {
        const text = n.getTextContent();
        const chars = Array.from(text);
        if (remaining < chars.length) {
          return { type: 'text', key: n.getKey(), offset: chars.slice(0, remaining).join('').length };
        }
        remaining -= chars.length;
        lastText = { type: 'text', key: n.getKey(), offset: text.length };
        continue;
      }
      if (remaining === 0) return { type: 'node', key: n.getKey() };
      remaining -= 1;
    }
    return null;
  };
  return walk(block.getChildren()) ?? lastText ?? { type: 'node', key: block.getKey() };
}
