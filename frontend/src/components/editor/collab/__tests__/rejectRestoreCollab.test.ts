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
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list';
import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { LinkNode } from '@lexical/link';
import { $generateJSONFromSelectedNodes, $generateNodesFromSerializedNodes, $insertGeneratedNodes } from '@lexical/clipboard';
import { createBinding, Provider, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';
import { DeletedTextNode } from '../../nodes/DeletedTextNode';
import { ImageNode } from '../../nodes/ImageNode';
import { createLocalEditTracker } from '../localEditTracker';
import { trackProvenance } from '../provenance';
import { $stampPendingMarkers, reapplyRejectedChanges, resolveTrackedChange, ResolveTrackedChangeDetail } from '../../plugins/TrackedChangesPlugin';
import { $createDeletedTextNode } from '../../nodes/DeletedTextNode';
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

describe('a paragraph with a line break and its list, cut and pasted over an empty paragraph', () => {
  // The shape of the dev-site Moved card: "New for 2026:" + line break, then a list.
  function seedSection(c: Client): void {
    edit(c, () => {
      const root = $getRoot();
      root.append($createParagraphNode().append($createTextNode('Intro.')));
      root.append($createParagraphNode().append($createTextNode('New for 2026:').toggleFormat('bold'), $createTextNode(' '), $createLineBreakNode()));
      root.append($createListNode('bullet').append(
        $createListItemNode().append($createTextNode('Special price tickets.')),
        $createListItemNode().append($createTextNode('All passes in one email.')),
      ));
      root.append($createParagraphNode().append($createTextNode('Key Things to Know:')));
      root.append($createListNode('bullet').append($createListItemNode().append($createTextNode('Only claim a VP if needed.'))));
      root.append($createParagraphNode());
      root.append($createParagraphNode().append($createTextNode('General Info:')));
    }, 'history-merge');
  }

  function cutSectionAndPaste(a: Client): { cut: ChangeRecord; paste: ChangeRecord } {
    const tracker = createLocalEditTracker(a.doc, NODES, (tr) => tr.origin !== 'remote');
    let clipboard: any = null;
    const cutSession = tracker.begin();
    edit(a, () => {
      const from = $textIn(1, 'first');
      const to = ($getRoot().getChildAtIndex(2) as any).getLastChild().getLastChild();
      const sel = $createRangeSelection();
      sel.anchor.set(from.getKey(), 0, 'text');
      sel.focus.set(to.getKey(), to.getTextContentSize(), 'text');
      $setSelection(sel);
      clipboard = $generateJSONFromSelectedNodes(a.editor, sel);
      sel.removeText();
    });
    const cut = { id: 'cut', before: tracker.baselineJson(cutSession), after: tracker.currentJson() };
    tracker.end(cutSession);

    const pasteSession = tracker.begin();
    edit(a, () => {
      // The empty paragraph before "General Info:"
      const root = $getRoot();
      const target = root.getChildAtIndex(root.getChildrenSize() - 2) as any;
      const sel = $createRangeSelection();
      sel.anchor.set(target.getKey(), 0, 'element');
      sel.focus.set(target.getKey(), 0, 'element');
      $setSelection(sel);
      $insertGeneratedNodes(a.editor, $generateNodesFromSerializedNodes(clipboard.nodes), $getSelection() as any);
    });
    const paste = { id: 'paste', before: tracker.baselineJson(pasteSession), after: tracker.currentJson() };
    tracker.end(pasteSession);
    tracker.destroy();
    return { cut, paste };
  }

  const json = (c: Client) => {
    flush(c);
    return c.editor.getEditorState().read(() => JSON.stringify($getRoot().getChildren().map($exportNodeJSON)));
  };

  it("the paste's before-state has the empty paragraph back, without the pasted line break", () => {
    const a = client('A');
    seedSection(a);
    const { paste } = cutSectionAndPaste(a);
    const target = JSON.parse(paste.before).root.children[4];
    expect(target.type).toBe('paragraph');
    expect(JSON.stringify(target)).not.toContain('linebreak');
  });

  it('rejecting the cut, then the paste, restores the original exactly in both editors', () => {
    const a = client('A');
    const b = client('B');
    connect(a, b);
    seedSection(a);
    const original = json(a);
    const { cut, paste } = cutSectionAndPaste(a);
    expect(rejectOn(b, cut).result).toEqual({ restored: true, method: 'context' });
    expect(rejectOn(b, paste).result).toEqual({ restored: true, method: 'context' });
    expect(json(b)).toEqual(original);
    expect(json(a)).toEqual(original);
  });
});

describe('a typed deletion (its after-state holds its own marker)', () => {
  const docJson = (c: Client) => {
    flush(c);
    return c.editor.getEditorState().read(() => JSON.stringify($getRoot().getChildren().map($exportNodeJSON)));
  };

  it('reject turns the stamped marker back into text and leaves no marker', () => {
    const a = client('A');
    const b = client('B');
    connect(a, b);
    seed(a);
    const original = blocks(a);
    const tracker = createLocalEditTracker(a.doc, NODES, (tr) => tr.origin !== 'remote');
    const session = tracker.begin();
    // What DeletionInterceptionPlugin does for a Backspace over saved text: the text
    // becomes a pending marker with this client's pending key.
    edit(a, () => {
      const node = $textIn(0, 'first'); // "Welcome to the 2026 event. ..."
      const parts = node.splitText(15, 20); // "2026 "
      parts[1].replace($createDeletedTextNode({ changeId: '__pending_deletion__', deletedText: '2026 ', authorId: 'author-a', pendingKey: 'k1' }));
    });
    const change = { id: 'del-1', before: tracker.baselineJson(session), after: tracker.currentJson() };
    tracker.end(session);
    tracker.destroy();
    expect(change.after).toContain('__pending_deletion__');
    // The save stamps the marker (bookkeeping, synced to the reviewer).
    edit(a, () => { $stampPendingMarkers('del-1', ['k1']); }, 'tracked-changes-decoration');
    expect(docJson(b)).toContain('"changeId":"del-1"');

    const detail = rejectOn(b, change);
    expect(detail.result).toEqual({ restored: true, method: 'context' });
    for (const c of [a, b]) {
      expect(blocks(c)).toEqual(original);
      expect(docJson(c)).not.toContain('deleted-text');
    }
  });

  it('a collaborative reject without rich text unwraps only the markers stamped with its id', () => {
    const a = client('A');
    seed(a);
    edit(a, () => {
      const node = $textIn(0, 'first');
      const parts = node.splitText(15, 20, 27, 31);
      parts[1].replace($createDeletedTextNode({ changeId: 'del-1', deletedText: '2026 ', authorId: 'author-a' }));
      parts[3].replace($createDeletedTextNode({ changeId: '__pending_deletion__', deletedText: 'Plea', authorId: 'author-a' }));
    });
    const detail: ResolveTrackedChangeDetail = { changeId: 'del-1', action: 'reject', deletedTexts: ['2026 ', 'Plea'], pendingAuthorIds: ['author-a'] };
    resolveTrackedChange(a.editor, detail, true);
    expect(detail.result).toEqual({ restored: true, method: 'marker' });
    expect(blocks(a)[0]).toContain('the 2026 event.');
    expect(docJson(a)).toContain('"deletedText":"Plea"'); // a pending marker is never adopted
  });
});
