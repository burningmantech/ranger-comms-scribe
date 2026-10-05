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

/** Deletion-marker properties that change after creation (rename on save, display). */
const IGNORED_MARKER_PROPS = new Set(['changeId', 'authorName', 'authorColor']);

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

/**
 * Plan the reject of a change (before -> after) against the live document's top-level
 * blocks. `before` and `after` are Lexical editor-state JSON (string or object).
 */
export function planRejectRestore(before: Json, after: Json, liveBlocks: Json[]): RejectRestorePlan {
  const oldBlocks = blocksOf(before);
  const newBlocks = blocksOf(after);
  if (!oldBlocks || !newBlocks) return { ok: false, reason: 'the change has no rich text' };

  const interner = new Interner();
  const O = toUnits(oldBlocks, interner);
  const N = toUnits(newBlocks, interner);
  const L = toUnits(liveBlocks, interner);

  const patch = hunksOf(diffDocs(N, O));
  if (patch.length === 0) return { ok: true, replacements: [] };

  const img = new Int32Array(N.units.length).fill(-1);
  const alignment = diffDocs(N, L);
  for (const op of alignment) {
    if (op.type !== 'equal') continue;
    for (let k = 0; k < op.a1 - op.a0; k++) img[op.a0 + k] = op.b0 + k;
  }
  // Live text that isn't in the change's after-state (others' edits, moved text).
  const liveInserts = hunksOf(alignment).filter((x) => x.b1 > x.b0);

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

  const splices: Splice[] = [];
  for (const h of patch) {
    const restore = O.units.slice(h.b0, h.b1).filter((u) => !u.marker);
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
        continue; // someone has put it back already
      }
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
          continue;
        }
        return { ok: false, reason: 'the changed text has been edited or removed since' };
      }
    }
    splices.push({ ls, le, units: restore });
  }

  // Splices are in document order (the alignment is monotonic); refuse overlaps.
  splices.sort((x, y) => x.ls - y.ls || x.le - y.le);
  for (let i = 1; i < splices.length; i++) {
    if (splices[i].ls < splices[i - 1].le) return { ok: false, reason: 'the change overlaps itself in the document' };
  }

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

/** Apply a plan to serialized top-level blocks (pure; mirrors `$rejectByContext`). */
export function applyBlockReplacements(liveBlocks: Json[], replacements: BlockReplacement[]): Json[] {
  const out = [...liveBlocks];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    out.splice(r.start, r.deleteCount, ...r.nodes);
  }
  return out;
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

/**
 * Reject a change by context inside an editor update: plan against the current (pending)
 * tree, then replace only the top-level blocks that differ. Changes nothing on failure.
 */
export function $rejectByContext(before: Json, after: Json): RejectByContextResult {
  const root = $getRoot();
  const live = root.getChildren().map($exportNodeJSON);
  const plan = planRejectRestore(before, after, live);
  if (!plan.ok) return plan;
  if (plan.replacements.length === 0) return { ok: true, changed: false };

  let built: Array<{ start: number; deleteCount: number; nodes: LexicalNode[] }>;
  try {
    built = plan.replacements.map((r) => ({
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
