/**
 * Reject by context end to end: two headless editors bound to Yjs docs (like the browser's
 * CollaborationPlugin), change records captured with the real local-edit tracker, the
 * reject applied by TrackedChangesPlugin's resolve handler on the reviewer's editor, and
 * the result checked on the author's editor.
 */
import * as Y from 'yjs';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isTextNode,
  $setSelection,
  createEditor,
  LexicalEditor,
  TextNode,
} from 'lexical';
import { HeadingNode, QuoteNode, $createHeadingNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { LinkNode } from '@lexical/link';
import { $generateJSONFromSelectedNodes, $generateNodesFromSerializedNodes, $insertGeneratedNodes } from '@lexical/clipboard';
import { createBinding, Provider, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';
import { DeletedTextNode } from '../../nodes/DeletedTextNode';
import { ImageNode } from '../../nodes/ImageNode';
import { createLocalEditTracker } from '../localEditTracker';
import { trackProvenance } from '../provenance';
import { reapplyRejectedChanges, resolveTrackedChange, ResolveTrackedChangeDetail } from '../../plugins/TrackedChangesPlugin';
import { $exportNodeJSON, $resolveUnitPoint, locateChange } from '../rejectRestore';

// The same nodes as CollaborativeEditor ($parseSerializedNode needs every type registered).
const NODES = [
  HeadingNode, QuoteNode, ListItemNode, ListNode, CodeHighlightNode, CodeNode,
  TableNode, TableCellNode, TableRowNode, LinkNode, ImageNode, DeletedTextNode,
];
const provider = {
  awareness: {
    getLocalState: () => null, getStates: () => new Map(), off: () => {}, on: () => {},
    setLocalState: () => {}, setLocalStateField: () => {},
  },
  connect: () => {}, disconnect: () => {}, off: () => {}, on: () => {},
} as unknown as Provider;

interface Client { editor: LexicalEditor; doc: Y.Doc }

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

function connect(a: Client, b: Client): void {
  a.doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(b.doc, u, 'remote'); });
  b.doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(a.doc, u, 'remote'); });
}

/** Commit any pending remote sync first (in the browser it always lands before the next event). */
const flush = (c: Client) => c.editor.update(() => {}, { discrete: true });
const edit = (c: Client, fn: () => void, tag?: string) => {
  flush(c);
  c.editor.update(fn, { discrete: true, ...(tag ? { tag } : {}) });
};

/** Block-level text with types, e.g. "paragraph:Hello". */
function blocks(c: Client): string[] {
  flush(c);
  return c.editor.getEditorState().read(() =>
    $getRoot().getChildren().map((b) => `${b.getType()}:${b.getTextContent()}`),
  );
}

function $textIn(blockIndex: number, which: 'first' | 'last'): TextNode {
  const texts = ($getRoot().getChildAtIndex(blockIndex) as any).getChildren().filter((n: any) => $isTextNode(n));
  return which === 'first' ? texts[0] : texts[texts.length - 1];
}

function seed(c: Client): void {
  edit(c, () => {
    const root = $getRoot();
    root.append($createParagraphNode().append($createTextNode('Welcome to the 2026 event. Please read everything below.')));
    root.append($createParagraphNode().append(
      $createTextNode('New for 2026: '),
      $createTextNode('early arrival passes').toggleFormat('bold'),
      $createTextNode(' are available for build crews.'),
    ));
    root.append($createParagraphNode().append($createTextNode('Passes are limited to one per camp and must be requested by June 1.')));
    root.append($createHeadingNode('h2').append($createTextNode('Tickets')));
    root.append($createParagraphNode().append(
      $createTextNode('General admission is $75.'),
      $createLineBreakNode(),
      $createTextNode('When you arrive, check in at the gate with your ID.'),
    ));
    root.append($createParagraphNode().append($createTextNode('Thanks, and see you on the playa.')));
  }, 'history-merge');
}

interface ChangeRecord { id: string; before: string; after: string }

/**
 * A cuts the "New for 2026" section (two paragraphs) and pastes it right after "$75.",
 * as two tracked changes recorded the way the app records them.
 */
function cutAndPaste(a: Client): { change1: ChangeRecord; change2: ChangeRecord } {
  const tracker = createLocalEditTracker(a.doc, NODES, (tr) => tr.origin !== 'remote');

  let clipboard: any = null;
  const cutSession = tracker.begin();
  edit(a, () => {
    const from = $textIn(1, 'first');
    const to = $textIn(2, 'last');
    const sel = $createRangeSelection();
    sel.anchor.set(from.getKey(), 0, 'text');
    sel.focus.set(to.getKey(), to.getTextContentSize(), 'text');
    $setSelection(sel);
    clipboard = $generateJSONFromSelectedNodes(a.editor, sel);
    sel.removeText();
  });
  const change1 = { id: 'c1', before: tracker.baselineJson(cutSession), after: tracker.currentJson() };
  tracker.end(cutSession);

  const pasteSession = tracker.begin();
  edit(a, () => {
    // "$75." is now in block 3 (W, the emptied paragraph, Tickets, G, Z).
    const node = $textIn(3, 'first');
    const sel = $createRangeSelection();
    sel.anchor.set(node.getKey(), node.getTextContentSize(), 'text');
    sel.focus.set(node.getKey(), node.getTextContentSize(), 'text');
    $setSelection(sel);
    $insertGeneratedNodes(a.editor, $generateNodesFromSerializedNodes(clipboard.nodes), $getSelection() as any);
  });
  const change2 = { id: 'c2', before: tracker.baselineJson(pasteSession), after: tracker.currentJson() };
  tracker.end(pasteSession);
  tracker.destroy();
  return { change1, change2 };
}

/** What TrackedChangesEditor dispatches for a reject (collaborative mode), handled synchronously. */
function rejectOn(c: Client, change: ChangeRecord): ResolveTrackedChangeDetail {
  flush(c);
  const detail: ResolveTrackedChangeDetail = {
    changeId: change.id,
    action: 'reject',
    deletedTexts: [],
    pendingAuthorIds: ['author-a'],
    richTextOldValue: change.before,
    richTextNewValue: change.after,
  };
  resolveTrackedChange(c.editor, detail, true);
  return detail;
}

describe('reject by context through Yjs (the move from the bug report)', () => {
  let a: Client;
  let b: Client;
  let original: string[];
  beforeEach(() => {
    a = client('A');
    b = client('B');
    connect(a, b);
    seed(a);
    original = blocks(a);
    expect(blocks(b)).toEqual(original);
  });

  it('records the move as a deletion and an insertion', () => {
    const { change1, change2 } = cutAndPaste(a);
    expect(change1.before).toContain('New for 2026');
    expect(change1.after).not.toContain('New for 2026');
    expect(change2.after).toContain('$75.New for 2026');
    expect(blocks(b)).toEqual(blocks(a));
  });

  it('reviewer rejects the deletion, then the insertion: both editors are back to the original', () => {
    const { change1, change2 } = cutAndPaste(a);

    const r1 = rejectOn(b, change1);
    expect(r1.result).toEqual({ restored: true, method: 'context' }); // reported synchronously
    const mid = blocks(a);
    expect(mid.filter((x) => x.includes('Passes are limited')).length).toBe(2);
    expect(mid.slice(0, 3)).toEqual(original.slice(0, 3));

    const r2 = rejectOn(b, change2);
    expect(r2.result).toEqual({ restored: true, method: 'context' });
    expect(blocks(a)).toEqual(original);
    expect(blocks(b)).toEqual(original);
  });

  it('reviewer rejects the insertion, then the deletion: both editors are back to the original', () => {
    const { change1, change2 } = cutAndPaste(a);
    expect(rejectOn(b, change2).result?.restored).toBe(true);
    expect(blocks(a).some((x) => x.includes('New for 2026'))).toBe(false);
    expect(rejectOn(b, change1).result?.restored).toBe(true);
    expect(blocks(a)).toEqual(original);
    expect(blocks(b)).toEqual(original);
  });

  it("works while the reviewer's caret is inside the replaced text", () => {
    const { change1, change2 } = cutAndPaste(a);
    edit(b, () => {
      const node = $textIn(4, 'first'); // in the pasted "Passes are limited ..." block
      const sel = $createRangeSelection();
      sel.anchor.set(node.getKey(), 3, 'text');
      sel.focus.set(node.getKey(), 3, 'text');
      $setSelection(sel);
    });
    expect(rejectOn(b, change2).result?.restored).toBe(true);
    expect(rejectOn(b, change1).result?.restored).toBe(true);
    expect(blocks(a)).toEqual(original);
  });

  it('restores the formatting of the moved text', () => {
    const { change1, change2 } = cutAndPaste(a);
    rejectOn(b, change1);
    rejectOn(b, change2);
    flush(a);
    const bold = a.editor.getEditorState().read(() =>
      ($getRoot().getChildAtIndex(1) as any).getChildren().map((n: TextNode) => [n.getTextContent(), n.hasFormat('bold')]),
    );
    expect(bold).toEqual([['New for 2026: ', false], ['early arrival passes', true], [' are available for build crews.', false]]);
  });

  it("keeps the author's later edit elsewhere in the document", () => {
    const { change1, change2 } = cutAndPaste(a);
    edit(a, () => { const t = $textIn($getRoot().getChildrenSize() - 1, 'last'); t.spliceText(t.getTextContentSize(), 0, ' Bring water.', false); });
    rejectOn(b, change1);
    rejectOn(b, change2);
    const expected = [...original];
    expected[expected.length - 1] += ' Bring water.';
    expect(blocks(a)).toEqual(expected);
  });

  it('changes nothing and reports failure when the pasted text was rewritten', () => {
    const { change2 } = cutAndPaste(a);
    edit(a, () => {
      const root = $getRoot();
      $setSelection(null);
      // Replace the two blocks holding the pasted section with unrelated text.
      root.getChildAtIndex(3)!.replace($createParagraphNode().append($createTextNode('Completely different text by someone.')));
      root.getChildAtIndex(4)!.replace($createParagraphNode().append($createTextNode('Nothing like the original.')));
    });
    const before = blocks(a);
    const detail = rejectOn(b, change2);
    expect(detail.result?.restored).toBe(false);
    expect(blocks(a)).toEqual(before);
    expect(blocks(b)).toEqual(before);
  });

  it('reports failure and changes nothing for a collaborative reject without rich text', () => {
    cutAndPaste(a);
    const before = blocks(b);
    const detail: ResolveTrackedChangeDetail = { changeId: 'c2', action: 'reject', deletedTexts: [], insertedTexts: [] };
    resolveTrackedChange(b.editor, detail, true);
    expect(detail.result).toMatchObject({ restored: false });
    expect(blocks(b)).toEqual(before);
    expect(blocks(a)).toEqual(before);
  });

  it('undo of the reject (re-apply, oldest first) brings the move back in both editors', () => {
    const { change1, change2 } = cutAndPaste(a);
    const moved = blocks(a);
    rejectOn(b, change1);
    rejectOn(b, change2);
    expect(blocks(a)).toEqual(original);

    // The reviewer clicks Undo: TrackedChangesEditor re-applies the rejected changes.
    flush(b);
    const result = reapplyRejectedChanges(b.editor, [change1, change2], true);
    expect(result).toEqual({ ok: true });
    expect(blocks(b)).toEqual(moved);
    expect(blocks(a)).toEqual(moved);

    // ... and the move can be rejected again, back to the original.
    expect(rejectOn(b, change1).result?.restored).toBe(true);
    expect(rejectOn(b, change2).result?.restored).toBe(true);
    expect(blocks(a)).toEqual(original);
    expect(blocks(b)).toEqual(original);
  });

  it('undo of one reject re-applies only that change', () => {
    const { change1, change2 } = cutAndPaste(a);
    const moved = blocks(a);
    rejectOn(b, change2); // the paste is gone, the cut stays
    const afterReject = blocks(a);
    expect(afterReject.some((x) => x.includes('New for 2026'))).toBe(false);
    flush(b);
    expect(reapplyRejectedChanges(b.editor, [change2], true)).toEqual({ ok: true });
    expect(blocks(a)).toEqual(moved);
    expect(blocks(b)).toEqual(moved);
  });

  it("undo changes nothing and reports why when the change's place was rewritten", () => {
    const { change2 } = cutAndPaste(a);
    rejectOn(b, change2);
    edit(a, () => {
      const root = $getRoot();
      $setSelection(null);
      // Rewrite the paragraphs around where the paste was.
      root.getChildAtIndex(2)!.replace($createParagraphNode().append($createTextNode('Completely different text by someone.')));
      root.getChildAtIndex(3)!.replace($createParagraphNode().append($createTextNode('Nothing like the original.')));
    });
    const before = blocks(a);
    flush(b);
    const result = reapplyRejectedChanges(b.editor, [change2], true);
    expect(result.ok).toBe(false);
    expect(blocks(a)).toEqual(before);
    expect(blocks(b)).toEqual(before);
  });

  it('undo of an accept needs no document change: the accepted text is still there', () => {
    const { change2 } = cutAndPaste(a);
    const moved = blocks(a);
    flush(b);
    // Re-applying an accepted (never reverted) change is a no-op.
    expect(reapplyRejectedChanges(b.editor, [change2], true)).toEqual({ ok: true });
    expect(blocks(a)).toEqual(moved);
  });

  it('locates both halves of the move in the live document', () => {
    const { change1, change2 } = cutAndPaste(a);
    flush(b);
    const live = b.editor.getEditorState().read(() => $getRoot().getChildren().map($exportNodeJSON));
    const del = locateChange(change1.before, change1.after, live);
    const ins = locateChange(change2.before, change2.after, live);
    expect(del?.collapsed).toBe(true);
    expect(ins?.collapsed).toBe(false);
    // The insertion starts right after "$75." and resolves to that text node in the editor.
    const point = b.editor.getEditorState().read(() => $resolveUnitPoint(ins!.start));
    expect(point?.type).toBe('text');
    const text = b.editor.getEditorState().read(() => ($getNodeByKey(point!.key) as TextNode).getTextContent());
    expect(text.slice(0, (point as any).offset)).toBe('General admission is $75.');
  });

  it('runs the legacy path (no result) outside collaborative mode', () => {
    const { change2 } = cutAndPaste(a);
    flush(b);
    const detail: ResolveTrackedChangeDetail = {
      changeId: change2.id, action: 'reject', richTextOldValue: change2.before, richTextNewValue: change2.after,
    };
    resolveTrackedChange(b.editor, detail, false);
    expect(detail.result).toBeUndefined();
  });
});
