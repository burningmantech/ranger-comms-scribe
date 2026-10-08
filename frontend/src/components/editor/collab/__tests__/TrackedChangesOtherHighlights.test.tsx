/**
 * F15: rejecting one pending insertion must not strip the highlight from another one
 * (collaborative mode). Insertions have no marker nodes in the shared document: their
 * highlight is computed from the change record (its whole document before and after) against
 * the live document. It used to be found by matching the record's text, with up to 50
 * characters before it, in the live text; that context included the other change's text, so
 * once that change was rejected (or undone) the insertion was never found again, on any
 * client, even after a reload. It is now located with the reject's context locator.
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import * as Y from 'yjs';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  createEditor,
  LexicalEditor,
  TextNode,
} from 'lexical';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import { createBinding, Provider, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';
import { $createDeletedTextNode, $isDeletedTextNode, DeletedTextNode } from '../../nodes/DeletedTextNode';
import { ImageNode } from '../../nodes/ImageNode';
import { createLocalEditTracker } from '../localEditTracker';
import { trackProvenance } from '../provenance';
import { $exportNodeJSON, locateChangeText } from '../rejectRestore';
import TrackedChangesPlugin, {
  getHighlightCharRanges,
  reapplyRejectedChanges,
  resolveTrackedChange,
  TrackedChange,
} from '../../plugins/TrackedChangesPlugin';

const NODES = [HeadingNode, QuoteNode, ListItemNode, ListNode, LinkNode, ImageNode, DeletedTextNode];
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

const flush = (c: Client) => c.editor.update(() => {}, { discrete: true });
const edit = (c: Client, fn: () => void, tag?: string) => {
  flush(c);
  c.editor.update(fn, { discrete: true, ...(tag ? { tag } : {}) });
};
const liveBlocks = (editor: LexicalEditor) => editor.read(() => $getRoot().getChildren().map($exportNodeJSON));
const text = (editor: LexicalEditor) => editor.read(() => $getRoot().getTextContent());
/** The live plain text at the located ranges (one paragraph here, so offsets are text offsets). */
const located = (editor: LexicalEditor, change: { before: string; after: string }) => {
  const ranges = locateChangeText(change.before, change.after, liveBlocks(editor));
  return ranges?.map((r) => text(editor).slice(r.start, r.end));
};

interface ChangeRecord { id: string; before: string; after: string }

/** Casey types "Note: " at the start, then " Bring ID." at the end: two tracked insertions. */
function twoInsertions(a: Client): { c1: ChangeRecord; c2: ChangeRecord } {
  const tracker = createLocalEditTracker(a.doc, NODES, (tr) => tr.origin !== 'remote');
  const typeAt = (where: 'start' | 'end', value: string) => edit(a, () => {
    const node = ($getRoot().getFirstChild() as any)[where === 'start' ? 'getFirstChild' : 'getLastChild']() as TextNode;
    const offset = where === 'start' ? 0 : node.getTextContentSize();
    const sel = $createRangeSelection();
    sel.anchor.set(node.getKey(), offset, 'text');
    sel.focus.set(node.getKey(), offset, 'text');
    $setSelection(sel);
    sel.insertText(value);
  });
  const s1 = tracker.begin();
  typeAt('start', 'Note: ');
  const c1 = { id: 'c1', before: tracker.baselineJson(s1), after: tracker.currentJson() };
  tracker.end(s1);
  const s2 = tracker.begin();
  typeAt('end', ' Bring ID.');
  const c2 = { id: 'c2', before: tracker.baselineJson(s2), after: tracker.currentJson() };
  tracker.end(s2);
  tracker.destroy();
  return { c1, c2 };
}

const asPending = (c: ChangeRecord): TrackedChange => ({
  id: c.id, field: 'content', oldValue: '', newValue: '', changedBy: 'casey@example.com', status: 'pending',
  richTextOldValue: c.before, richTextNewValue: c.after,
});

/** The plugin as the review page mounts it (collaborative mode) on a document loaded from JSON. */
async function decorate(savedJson: string, pending: TrackedChange[]): Promise<LexicalEditor> {
  let editorRef: LexicalEditor | null = null;
  const Capture = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useLexicalComposerContext } = require('@lexical/react/LexicalComposerContext');
    const [editor] = useLexicalComposerContext();
    editorRef = editor;
    return null;
  };
  render(
    <LexicalComposer initialConfig={{ namespace: 'decorate', nodes: NODES, editorState: savedJson, onError: (e: Error) => { throw e; } }}>
      <TrackedChangesPlugin pendingChanges={pending} originalText="" onChangeClick={() => {}} collabMode="yjs" />
      <Capture />
    </LexicalComposer>,
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  return editorRef!;
}

describe('F15: the other pending insertion keeps its highlight when one is rejected', () => {
  let a: Client; // Casey, the author
  let b: Client; // the reviewer (Casey herself in the report; another client here, to check both)
  let c1: ChangeRecord;
  let c2: ChangeRecord;

  beforeAll(() => {
    (globalThis as any).CSS = { highlights: new Map(), escape: (s: string) => s };
    (window as any).Highlight = class { constructor(..._ranges: unknown[]) {} };
  });

  beforeEach(() => {
    a = client('A');
    b = client('B');
    connect(a, b);
    edit(a, () => {
      $getRoot().append($createParagraphNode().append($createTextNode('Gate opens at noon.')));
    }, 'history-merge');
    ({ c1, c2 } = twoInsertions(a));
    expect(text(b.editor)).toBe('Note: Gate opens at noon. Bring ID.');
  });

  it('locates both insertions before anything is decided', () => {
    expect(located(b.editor, c1)).toEqual(['Note: ']);
    expect(located(b.editor, c2)).toEqual([' Bring ID.']);
  });

  it('after the reject of "Note: ", " Bring ID." is still located on both clients and in the saved document', () => {
    const detail: any = { changeId: 'c1', action: 'reject', richTextOldValue: c1.before, richTextNewValue: c1.after };
    resolveTrackedChange(b.editor, detail, true);
    expect(detail.result).toEqual({ restored: true, method: 'context' });
    flush(a);
    expect(text(a.editor)).toBe('Gate opens at noon. Bring ID.');

    expect(located(a.editor, c2)).toEqual([' Bring ID.']);
    expect(located(b.editor, c2)).toEqual([' Bring ID.']);
    // Reload: a fresh editor from the content the reject saves (the reviewer's document)
    const saved = createEditor({ namespace: 'saved', nodes: NODES, onError: (e) => { throw e; } });
    saved.setEditorState(saved.parseEditorState(JSON.stringify(b.editor.getEditorState().toJSON())));
    expect(located(saved, c2)).toEqual([' Bring ID.']);
  });

  it("a pending deletion's marker keeps its change id on both clients when another change is rejected", () => {
    // Casey also deleted "noon" (change del-1): its marker sits in the same paragraph
    edit(a, () => {
      const node = ($getRoot().getFirstChild() as any).getFirstChild() as TextNode;
      const at = node.getTextContent().indexOf('noon');
      const [, middle] = node.splitText(at, at + 4);
      middle.replace($createDeletedTextNode({ changeId: 'del-1', deletedText: 'noon', authorId: 'casey-id' }));
    });
    flush(b); // the remote edit lands before the reviewer's click (as in the browser)
    const detail: any = { changeId: 'c1', action: 'reject', richTextOldValue: c1.before, richTextNewValue: c1.after };
    resolveTrackedChange(b.editor, detail, true);
    expect(detail.result).toEqual({ restored: true, method: 'context' });
    for (const c of [a, b]) {
      flush(c);
      const markers = c.editor.read(() => ($getRoot().getFirstChild() as any).getChildren()
        .filter($isDeletedTextNode).map((n: DeletedTextNode) => `${n.getDeletedText()}:${n.getChangeId()}`));
      expect(markers).toEqual(['noon:del-1']);
      expect(text(c.editor)).toBe('Gate opens at . Bring ID.');
    }
  });

  it('the plugin highlights " Bring ID." after the other change is rejected (and after a reload)', async () => {
    resolveTrackedChange(b.editor, { changeId: 'c1', action: 'reject', richTextOldValue: c1.before, richTextNewValue: c1.after } as any, true);
    const saved = JSON.stringify(b.editor.getEditorState().toJSON());
    const editor = await decorate(saved, [asPending(c2)]);
    const ranges = getHighlightCharRanges('c2');
    expect(ranges.map((r) => text(editor).slice(r.start, r.end))).toEqual([' Bring ID.']);
  });

  it('undo of the reject of " Bring ID." re-applies it highlighted', async () => {
    resolveTrackedChange(b.editor, { changeId: 'c1', action: 'reject', richTextOldValue: c1.before, richTextNewValue: c1.after } as any, true);
    resolveTrackedChange(b.editor, { changeId: 'c2', action: 'reject', richTextOldValue: c2.before, richTextNewValue: c2.after } as any, true);
    expect(text(b.editor)).toBe('Gate opens at noon.');
    expect(reapplyRejectedChanges(b.editor, [{ id: 'c2', before: c2.before, after: c2.after }], true)).toEqual({ ok: true });
    expect(text(a.editor)).toBe('Gate opens at noon. Bring ID.');
    expect(located(a.editor, c2)).toEqual([' Bring ID.']);
    const editor = await decorate(JSON.stringify(b.editor.getEditorState().toJSON()), [asPending(c2)]);
    expect(getHighlightCharRanges('c2').map((r) => text(editor).slice(r.start, r.end))).toEqual([' Bring ID.']);
  });
});

describe('an insertion inside a list item', () => {
  beforeAll(() => {
    (globalThis as any).CSS = { highlights: new Map(), escape: (s: string) => s };
    (window as any).Highlight = class { constructor(..._ranges: unknown[]) {} };
  });

  it('is not located by context (a list is one unit there); the plugin highlights only the inserted text', async () => {
    const a = client('A');
    edit(a, () => {
      $getRoot().append($createParagraphNode().append($createTextNode('Bring:')));
      $getRoot().append($createListNode('bullet').append(
        $createListItemNode().append($createTextNode('water')),
        $createListItemNode().append($createTextNode('a hat')),
      ));
    }, 'history-merge');
    const tracker = createLocalEditTracker(a.doc, NODES, (tr) => tr.origin !== 'remote');
    const session = tracker.begin();
    edit(a, () => {
      const item = ($getRoot().getChildAtIndex(1) as any).getFirstChild();
      const node = item.getFirstChild() as TextNode;
      const sel = $createRangeSelection();
      sel.anchor.set(node.getKey(), 0, 'text');
      sel.focus.set(node.getKey(), 0, 'text');
      $setSelection(sel);
      sel.insertText('lots of ');
    });
    const change = { id: 'l1', before: tracker.baselineJson(session), after: tracker.currentJson() };
    tracker.end(session);
    tracker.destroy();

    expect(locateChangeText(change.before, change.after, liveBlocks(a.editor))).toBeNull();
    const editor = await decorate(JSON.stringify(a.editor.getEditorState().toJSON()), [asPending(change)]);
    const plain = editor.read(() => $getRoot().getChildren().map((b) => b.getTextContent()).join(''));
    expect(getHighlightCharRanges('l1').map((r) => plain.slice(r.start, r.end))).toEqual(['lots of ']);
  });
});
