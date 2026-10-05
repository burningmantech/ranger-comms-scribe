import * as Y from 'yjs';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  createEditor,
  LexicalEditor,
  TextNode,
} from 'lexical';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { createBinding, Provider, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';
import { DeletedTextNode, $createDeletedTextNode } from '../../nodes/DeletedTextNode';
import { createLocalEditTracker, lexicalJsonFromYDoc } from '../localEditTracker';
import { trackProvenance } from '../provenance';
import { $createRangeSelection, $getSelection, $isRangeSelection, $setSelection } from 'lexical';
import { $createHeadingNode } from '@lexical/rich-text';
import { extractTextFromLexical } from '../../../../utils/lexicalUtils';

const NODES = [HeadingNode, QuoteNode, DeletedTextNode];
const provider = {
  awareness: {
    getLocalState: () => null, getStates: () => new Map(), off: () => {}, on: () => {},
    setLocalState: () => {}, setLocalStateField: () => {},
  },
  connect: () => {}, disconnect: () => {}, off: () => {}, on: () => {},
} as unknown as Provider;

interface Client { editor: LexicalEditor; doc: Y.Doc }

/** A headless editor bound to its own Y.Doc, like CollaborationPlugin binds the browser editor. */
function client(name: string): Client {
  const editor = createEditor({ namespace: name, nodes: NODES, onError: (e) => { throw e; } });
  const doc = new Y.Doc({ gc: false });
  trackProvenance(doc);
  const binding = createBinding(editor, provider, 'room', doc, new Map([['room', doc]]));
  binding.root.getSharedType().observeDeep((events, tr) => {
    if (tr.origin !== binding) syncYjsChangesToLexical(binding, provider, events as any, false, () => {});
  });
  editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    if (!tags.has('skip-collab')) {
      syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
    }
  });
  return { editor, doc };
}

/** Relay updates between two docs (origin 'remote' on the receiving side). */
function connect(a: Client, b: Client): void {
  a.doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(b.doc, u, 'remote'); });
  b.doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(a.doc, u, 'remote'); });
}

/**
 * A local edit. First commits any pending remote sync on its own: in the browser a remote
 * update (WebSocket message) always commits before the next keystroke, but here both run
 * in the same tick and would merge into one update tagged 'collaboration' (not synced).
 */
const edit = (c: Client, fn: () => void, tag?: string) => {
  c.editor.update(() => {}, { discrete: true });
  c.editor.update(fn, { discrete: true, ...(tag ? { tag } : {}) });
};
const text = (json: string) => extractTextFromLexical(json);
function $firstText(blockIndex: number): TextNode {
  const block = $getRoot().getChildAtIndex(blockIndex) as any;
  const node = block.getChildren().find((n: any) => $isTextNode(n));
  return node as TextNode;
}

describe('localEditTracker', () => {
  let a: Client;
  let b: Client;
  beforeEach(() => {
    a = client('A');
    b = client('B');
    connect(a, b);
    edit(a, () => {
      $getRoot().append($createParagraphNode().append($createTextNode('Hello world.')));
      $getRoot().append($createParagraphNode().append($createTextNode('Second line.')));
    }, 'history-merge');
    expect(lexicalJsonFromYDoc(b.doc, NODES)).toContain('Hello world.');
  });

  it("takes out only the local user's edits; other users' edits stay in the before-state", () => {
    const tracker = createLocalEditTracker(a.doc, NODES, (tr) => tr.origin !== 'remote');
    const session = tracker.begin();
    edit(a, () => { $firstText(0).spliceText(0, 0, 'AAA ', false); });
    edit(b, () => { const t = $firstText(1); t.spliceText(t.getTextContentSize(), 0, ' BBB', false); });
    edit(a, () => { const t = $firstText(0); t.spliceText(t.getTextContentSize(), 0, ' AAA2', false); });

    expect(text(tracker.currentJson())).toBe('AAA Hello world. AAA2\nSecond line. BBB');
    expect(text(tracker.baselineJson(session))).toBe('Hello world.\nSecond line. BBB');
  });

  it("restores text the local user deleted, and hides their deletion markers", () => {
    const tracker = createLocalEditTracker(a.doc, NODES, (tr) => tr.origin !== 'remote');
    const session = tracker.begin();
    edit(a, () => {
      const t = $firstText(0);
      const [, world] = t.splitText(6, 11); // "world"
      world.insertBefore($createDeletedTextNode({ changeId: '__pending_deletion__', deletedText: 'world', authorId: 'a' }));
      world.remove();
    });
    const current = tracker.currentJson();
    expect(text(current)).toBe('Hello .\nSecond line.');
    expect(current).toContain('deleted-text');
    const before = tracker.baselineJson(session);
    expect(text(before)).toBe('Hello world.\nSecond line.');
    expect(before).not.toContain('deleted-text');
  });

  it('ignores edits made before the session began and transactions that are not local edits', () => {
    edit(a, () => { $firstText(0).spliceText(0, 0, 'Earlier ', false); });
    const bookkeeping = new Set<unknown>();
    const tracker = createLocalEditTracker(a.doc, NODES, (tr) => tr.origin !== 'remote' && !bookkeeping.has(tr));
    a.doc.on('beforeTransaction', (tr: Y.Transaction) => { if (tagNext) bookkeeping.add(tr); });
    let tagNext = false;
    const session = tracker.begin();
    tagNext = true;
    edit(a, () => { const t = $firstText(1); t.spliceText(0, 0, 'Bookkeeping ', false); });
    tagNext = false;
    edit(a, () => { const t = $firstText(1); t.spliceText(t.getTextContentSize(), 0, ' mine', false); });
    expect(text(tracker.baselineJson(session))).toBe('Earlier Hello world.\nBookkeeping Second line.');
    tracker.end(session);
  });

  it('can convert inside another editor\'s update (DeletionInterceptionPlugin asks during a key command)', () => {
    const tracker = createLocalEditTracker(a.doc, NODES, () => true);
    const session = tracker.begin();
    let inside = '';
    edit(a, () => {
      $firstText(0).spliceText(0, 0, 'X', false);
      inside = text(tracker.baselineJson(session));
    });
    expect(inside).toBe('Hello world.\nSecond line.');
  });

  // ---- Attribution across structural edits (paragraph split, bold, type change, merge) ----

  /** Characters `after` has that `before` doesn't (LCS). */
  function added(before: string, after: string): string {
    const m = before.length, n = after.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0, out = '';
    while (j < n) { if (i < m && before[i] === after[j]) { i++; j++; } else if (i < m && dp[i + 1][j] >= dp[i][j + 1]) i++; else out += after[j++]; }
    return out;
  }
  function removed(before: string, after: string): string { return added(after, before); }
  /** Caret at `offset` in the first text node of block `blockIndex`, or at its end (-1). */
  function $caret(blockIndex: number, offset = -1): void {
    const block = $getRoot().getChildAtIndex(blockIndex) as any;
    const texts = block.getChildren().filter((n: any) => $isTextNode(n));
    const node = offset < 0 ? texts[texts.length - 1] : texts[0];
    const at = offset < 0 ? node.getTextContentSize() : offset;
    const sel = $createRangeSelection();
    sel.anchor.set(node.getKey(), at, 'text');
    sel.focus.set(node.getKey(), at, 'text');
    $setSelection(sel);
  }
  function typeAt(c: Client, chars: string, place: () => void): void {
    edit(c, place);
    for (const ch of chars) edit(c, () => { const sel = $getSelection(); if ($isRangeSelection(sel)) sel.insertText(ch); });
  }
  const splitAt = (c: Client, blockIndex: number, offset: number) => edit(c, () => {
    $caret(blockIndex, offset);
    const sel = $getSelection();
    if ($isRangeSelection(sel)) sel.insertParagraph();
  });
  const isLocal = (tr: Y.Transaction) => tr.origin !== 'remote';
  function attribution(c: Client, session: ReturnType<ReturnType<typeof createLocalEditTracker>['begin']>, tracker: ReturnType<typeof createLocalEditTracker>) {
    const before = text(tracker.baselineJson(session));
    const after = text(tracker.currentJson());
    return { before, after, added: added(before, after), removed: removed(before, after) };
  }

  it('Enter after a word while the other user types at the end of the line: each change has only its own text', () => {
    const ta = createLocalEditTracker(a.doc, NODES, isLocal);
    const tb = createLocalEditTracker(b.doc, NODES, isLocal);
    const typist = ta.begin();
    typeAt(a, ' {hh', () => $caret(0));
    const splitter = tb.begin();
    splitAt(b, 0, 5); // after "Hello"
    typeAt(a, 'hhhh}', () => $caret(1)); // the typist keeps typing at the end (now in the new paragraph)

    const ra = attribution(a, typist, ta);
    expect(ra.after).toBe('Hello\n world. {hhhhhh}\nSecond line.');
    expect(ra.added).toBe(' {hhhhhh}');
    expect(ra.removed).toBe('');
    const rb = attribution(b, splitter, tb);
    expect(rb.added.trim()).toBe('');
    expect(rb.removed.trim()).toBe('');
    expect(rb.before).toBe('Hello world. {hhhhhh}\nSecond line.');
  });

  it('Enter inside the text the other user is typing: each change has only its own text', () => {
    const ta = createLocalEditTracker(a.doc, NODES, isLocal);
    const tb = createLocalEditTracker(b.doc, NODES, isLocal);
    const typist = ta.begin();
    typeAt(a, ' {hhhh', () => $caret(0));
    const splitter = tb.begin();
    splitAt(b, 0, 'Hello world. {hh'.length); // inside the typed text
    typeAt(a, 'hh}', () => $caret(1));

    const ra = attribution(a, typist, ta);
    expect(ra.after).toBe('Hello world. {hh\nhhhh}\nSecond line.');
    expect(ra.added.replace(/\n/g, '')).toBe(' {hhhhhh}');
    const rb = attribution(b, splitter, tb);
    expect(rb.added.trim()).toBe('');
    expect(rb.removed.trim()).toBe('');
  });

  it('Enter in the paragraph before the typist starts: the typist still gets all of their text', () => {
    const ta = createLocalEditTracker(a.doc, NODES, isLocal);
    const tb = createLocalEditTracker(b.doc, NODES, isLocal);
    const splitter = tb.begin();
    splitAt(b, 0, 5);
    const typist = ta.begin();
    typeAt(a, ' {hhh}', () => $caret(1));
    expect(attribution(a, typist, ta).added).toBe(' {hhh}');
    const rb = attribution(b, splitter, tb);
    expect(rb.added.trim()).toBe('');
  });

  it('bold on the word the other user is typing in: the typist keeps all their text, the formatter adds none', () => {
    const ta = createLocalEditTracker(a.doc, NODES, isLocal);
    const tb = createLocalEditTracker(b.doc, NODES, isLocal);
    const typist = ta.begin();
    typeAt(a, 'QQ', () => $caret(0, 8)); // "Hello wo|rld."
    const formatter = tb.begin();
    edit(b, () => {
      const node = (($getRoot().getChildAtIndex(0) as any).getChildren()[0]) as TextNode;
      const sel = $createRangeSelection();
      sel.anchor.set(node.getKey(), 6, 'text');
      sel.focus.set(node.getKey(), 13, 'text'); // "woQQrld"
      $setSelection(sel);
      const s2 = $getSelection();
      if ($isRangeSelection(s2)) s2.formatText('bold');
    });
    typeAt(a, 'Q', () => {
      const block = $getRoot().getChildAtIndex(0) as any;
      const bold = block.getChildren().find((n: any) => $isTextNode(n) && n.hasFormat('bold')) as TextNode;
      const sel = $createRangeSelection();
      sel.anchor.set(bold.getKey(), 4, 'text');
      sel.focus.set(bold.getKey(), 4, 'text');
      sel.format = bold.getFormat(); // a caret placed in bold text types bold, as in the browser
      $setSelection(sel);
    });
    expect(attribution(a, typist, ta).added).toBe('QQQ');
    const rb = attribution(b, formatter, tb);
    expect(rb.added).toBe('');
    expect(rb.removed).toBe('');
    expect(tb.baselineJson(formatter)).not.toContain('"format":1');
  });

  it('block type change while the other user types in the block: type reverts, text stays the typist\'s', () => {
    const ta = createLocalEditTracker(a.doc, NODES, isLocal);
    const tb = createLocalEditTracker(b.doc, NODES, isLocal);
    const typist = ta.begin();
    typeAt(a, ' AAA', () => $caret(1));
    const changer = tb.begin();
    edit(b, () => {
      const para = $getRoot().getChildAtIndex(1)!;
      const heading = $createHeadingNode('h2');
      heading.append(...(para as any).getChildren());
      para.replace(heading);
    });
    typeAt(a, 'A', () => $caret(1));
    expect(attribution(a, typist, ta).added).toBe(' AAAA');
    const rb = attribution(b, changer, tb);
    expect(rb.added).toBe('');
    expect(rb.removed).toBe('');
    const before = JSON.parse(tb.baselineJson(changer)).root.children.map((n: any) => n.type);
    const after = JSON.parse(tb.currentJson()).root.children.map((n: any) => n.type);
    expect(before).toEqual(['paragraph', 'paragraph']);
    expect(after).toEqual(['paragraph', 'heading']);
  });

  it('merging two paragraphs (Backspace at the start) adds no text', () => {
    const tb = createLocalEditTracker(b.doc, NODES, isLocal);
    const merger = tb.begin();
    edit(b, () => {
      const second = $getRoot().getChildAtIndex(1) as any;
      const first = $getRoot().getChildAtIndex(0) as any;
      first.append(...second.getChildren());
      second.remove();
    });
    const rb = attribution(b, merger, tb);
    expect(rb.after).toBe('Hello world.Second line.');
    expect(rb.added).toBe('');
    expect(rb.removed.trim()).toBe('');
  });
});

