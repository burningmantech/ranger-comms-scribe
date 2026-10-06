/**
 * $restoreCaret when the caret's block is gone: another user's reject (or delete) removed
 * the paragraph the local caret was in. The captured Yjs position then resolves into the
 * deleted paragraph, whose Lexical nodes no longer exist; setting a point on them threw
 * "PointType.set: node with key … not found" inside the restore update.
 *
 * Two headless editors bound to Yjs docs, as in rejectRestoreCollab.test.ts.
 */
import * as Y from 'yjs';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  createEditor,
  LexicalEditor,
  TextNode,
} from 'lexical';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { LinkNode } from '@lexical/link';
import { createBinding, Provider, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';
import { DeletedTextNode } from '../../nodes/DeletedTextNode';
import { ImageNode } from '../../nodes/ImageNode';
import { $restoreCaret } from '../caretPreservation';

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

interface Client { editor: LexicalEditor; doc: Y.Doc; root: Y.XmlText }

function client(name: string): Client {
  // onError rethrows: an error inside an update fails the test instead of being swallowed
  const editor = createEditor({ namespace: name, nodes: NODES, onError: (e) => { throw e; } });
  const doc = new Y.Doc({ gc: false });
  const binding = createBinding(editor, provider, 'room', doc, new Map([['room', doc]]));
  binding.root.getSharedType().observeDeep((events, tr) => {
    if (tr.origin !== binding) syncYjsChangesToLexical(binding, provider, events as any, false, () => {});
  });
  editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    if (!tags.has('skip-collab')) {
      syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
    }
  });
  return { editor, doc, root: binding.root.getSharedType() as Y.XmlText };
}

function connect(a: Client, b: Client): void {
  a.doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(b.doc, u, 'remote'); });
  b.doc.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(a.doc, u, 'remote'); });
}

const flush = (c: Client) => c.editor.update(() => {}, { discrete: true });
const edit = (c: Client, fn: () => void) => {
  flush(c);
  c.editor.update(fn, { discrete: true });
};
const texts = (c: Client): string[] => {
  flush(c);
  return c.editor.getEditorState().read(() => $getRoot().getChildren().map((b) => b.getTextContent()));
};

/** A left-anchored Yjs position after character `charIndex` of block `blockIndex` (what the capture records). */
function positionIn(c: Client, blockIndex: number, charIndex: number): Y.RelativePosition {
  const blocks = (c.root.toDelta() as Array<{ insert: unknown }>).map((d) => d.insert).filter((x): x is Y.XmlText => x instanceof Y.XmlText);
  const block = blocks[blockIndex];
  // A paragraph's XmlText holds an embedded map (the text node's properties) before its text.
  let index = 0;
  let remaining = charIndex;
  for (const d of block.toDelta() as Array<{ insert: unknown }>) {
    if (typeof d.insert === 'string') {
      if (remaining <= d.insert.length) { index += remaining; remaining = 0; break; }
      index += d.insert.length;
      remaining -= d.insert.length;
    } else {
      index += 1;
    }
  }
  return Y.createRelativePositionFromTypeIndex(block, index, -1);
}

function $selectEnd(blockIndex: number): void {
  const text = ($getRoot().getChildAtIndex(blockIndex) as any).getChildren().find((n: any) => $isTextNode(n)) as TextNode;
  const sel = $createRangeSelection();
  sel.anchor.set(text.getKey(), text.getTextContentSize(), 'text');
  sel.focus.set(text.getKey(), text.getTextContentSize(), 'text');
  $setSelection(sel);
}

/** The selection's anchor: its node's text and offset, or null when it points at a missing node. */
function caretOf(c: Client): { text: string; offset: number } | null {
  return c.editor.getEditorState().read(() => {
    const sel = $getSelection();
    if (!$isRangeSelection(sel)) return null;
    const node = $getNodeByKey(sel.anchor.key);
    if (!node || !node.isAttached()) return null;
    return { text: node.getTextContent(), offset: sel.anchor.offset };
  });
}

describe('$restoreCaret: the caret\'s block was removed by another user', () => {
  let a: Client;
  let b: Client;

  beforeEach(() => {
    a = client('A');
    b = client('B');
    connect(a, b);
    edit(a, () => {
      const root = $getRoot();
      root.append($createParagraphNode().append($createTextNode('First paragraph text.')));
      root.append($createParagraphNode().append($createTextNode('Doomed block')));
      root.append($createParagraphNode().append($createTextNode('Third one.')));
    });
    expect(texts(b)).toEqual(['First paragraph text.', 'Doomed block', 'Third one.']);
  });

  it('does not throw and leaves a caret on a node that exists', () => {
    // A's caret is at the end of "Doomed block"; the capture records it (left-anchored).
    edit(a, () => $selectEnd(1));
    const pos = positionIn(a, 1, 'Doomed block'.length);
    const pending = { anchor: pos, focus: pos, collapsed: true, context: { left: 'Doomed block', right: '' } };

    // B removes that paragraph (as a reject of A's inserted block does); it reaches A.
    edit(b, () => { $getRoot().getChildAtIndex(1)!.remove(); });
    expect(texts(a)).toEqual(['First paragraph text.', 'Third one.']);

    let restored: boolean | undefined;
    expect(() => {
      a.editor.update(() => { restored = $restoreCaret(a.doc, pending); }, { discrete: true });
    }).not.toThrow();
    expect(restored).toBe(false);

    // The caret is somewhere real (Lexical's recovery, or the document start), and typing works.
    expect(caretOf(a)).not.toBeNull();
    edit(a, () => { const sel = $getSelection(); if ($isRangeSelection(sel)) sel.insertText('Z'); });
    expect(texts(a).join('|')).toContain('Z');
    expect(texts(b)).toEqual(texts(a));
  });

  it('falls back to the start of the document when the selection is gone too', () => {
    edit(a, () => $selectEnd(1));
    const pos = positionIn(a, 1, 'Doomed block'.length);
    edit(b, () => { $getRoot().getChildAtIndex(1)!.remove(); });
    flush(a);

    a.editor.update(() => {
      $setSelection(null);
      $restoreCaret(a.doc, { anchor: pos, focus: pos, collapsed: true, context: null });
    }, { discrete: true });
    expect(caretOf(a)).toEqual({ text: 'First paragraph text.', offset: 0 });
  });

  it('still restores normally when the block survives', () => {
    edit(a, () => $selectEnd(2));
    const pos = positionIn(a, 2, 'Third'.length);
    edit(b, () => { $getRoot().getChildAtIndex(1)!.remove(); });
    flush(a);

    let restored: boolean | undefined;
    a.editor.update(() => {
      restored = $restoreCaret(a.doc, { anchor: pos, focus: pos, collapsed: true, context: { left: 'Third', right: ' one.' } });
    }, { discrete: true });
    expect(restored).toBe(true);
    expect(caretOf(a)).toEqual({ text: 'Third one.', offset: 'Third'.length });
  });
});
