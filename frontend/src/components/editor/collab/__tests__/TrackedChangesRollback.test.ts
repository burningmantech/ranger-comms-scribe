/**
 * Rolling back an accept or reject the server refused (collaborative mode): the reviewer's
 * resolve already changed the shared document (an accept removes the change's deletion
 * markers, a reject reverts its text), and everyone got that through Yjs. revertResolve undoes
 * it from the snapshots taken around the resolve, so every client is back where it was, and
 * edits others made in the meantime are kept.
 */
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
import { ListItemNode, ListNode } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import { createBinding, Provider, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';
import { $createDeletedTextNode, $isDeletedTextNode, DeletedTextNode } from '../../nodes/DeletedTextNode';
import { ImageNode } from '../../nodes/ImageNode';
import { resolveTrackedChange, revertResolve, snapshotDocument } from '../../plugins/TrackedChangesPlugin';

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

/** Each block's children as "text" or "[-deleted:changeId]". */
function shape(c: Client): string[] {
  flush(c);
  return c.editor.getEditorState().read(() => $getRoot().getChildren().map((b: any) =>
    b.getChildren().map((n: any) => ($isDeletedTextNode(n) ? `[-${n.getDeletedText()}:${n.getChangeId()}]` : n.getTextContent())).join('')));
}

const lexical = (...paragraphs: string[]) => JSON.stringify({
  root: {
    type: 'root', version: 1, direction: null, format: '', indent: 0,
    children: paragraphs.map((text) => ({
      type: 'paragraph', version: 1, direction: null, format: '', indent: 0, textFormat: 0, textStyle: '',
      children: [{ type: 'text', version: 1, text, format: 0, style: '', mode: 'normal', detail: 0 }],
    })),
  },
});

describe('revertResolve: undoing a refused accept or reject through Yjs', () => {
  let a: Client; // the author
  let b: Client; // the reviewer
  beforeEach(() => {
    a = client('A');
    b = client('B');
    connect(a, b);
    // The author deleted "2026 " (change del-1): its marker is in the shared document
    edit(a, () => {
      const root = $getRoot();
      root.append($createParagraphNode().append(
        $createTextNode('Welcome to the '),
        $createDeletedTextNode({ changeId: 'del-1', deletedText: '2026 ', authorId: 'author-a' }),
        $createTextNode('event. Please read everything below.'),
      ));
      root.append($createParagraphNode().append($createTextNode('Passes are limited to one per camp.')));
    }, 'history-merge');
    expect(shape(b)).toEqual(shape(a));
  });

  it("an accept removed the change's markers for everyone; the revert puts them back for everyone, with the change id", () => {
    const original = shape(a);
    const before = snapshotDocument(b.editor)!;
    resolveTrackedChange(b.editor, { changeId: 'del-1', action: 'approve' }, true);
    const after = snapshotDocument(b.editor)!;
    expect(shape(a)[0]).toBe('Welcome to the event. Please read everything below.');

    expect(revertResolve(b.editor, before, after, 'del-1')).toEqual({ ok: true });
    expect(shape(b)).toEqual(original);
    expect(shape(a)).toEqual(original);
  });

  it('keeps an edit another user made between the accept and the revert', () => {
    const before = snapshotDocument(b.editor)!;
    resolveTrackedChange(b.editor, { changeId: 'del-1', action: 'approve' }, true);
    const after = snapshotDocument(b.editor)!;

    // The author types in the second paragraph meanwhile
    edit(a, () => {
      const text = ($getRoot().getChildAtIndex(1) as any).getFirstChild() as TextNode;
      text.setTextContent('Passes are limited to one per camp, and must be requested by June 1.');
    });

    expect(revertResolve(b.editor, before, after, 'del-1')).toEqual({ ok: true });
    const expected = [
      'Welcome to the [-2026 :del-1]event. Please read everything below.',
      'Passes are limited to one per camp, and must be requested by June 1.',
    ];
    expect(shape(b)).toEqual(expected);
    expect(shape(a)).toEqual(expected);
  });

  it('a reject that reverted the text by context is re-applied for everyone', () => {
    // A second change (ins-1) added ", and must be requested by June 1"
    edit(a, () => {
      const text = ($getRoot().getChildAtIndex(1) as any).getFirstChild() as TextNode;
      text.setTextContent('Passes are limited to one per camp, and must be requested by June 1.');
    });
    const withChange = shape(a);
    const before = snapshotDocument(b.editor)!;
    const detail: any = {
      changeId: 'ins-1',
      action: 'reject',
      richTextOldValue: lexical('Welcome to the event. Please read everything below.', 'Passes are limited to one per camp.'),
      richTextNewValue: lexical('Welcome to the event. Please read everything below.', 'Passes are limited to one per camp, and must be requested by June 1.'),
    };
    resolveTrackedChange(b.editor, detail, true);
    expect(detail.result).toEqual({ restored: true, method: 'context' });
    expect(shape(a)[1]).toBe('Passes are limited to one per camp.');
    const after = snapshotDocument(b.editor)!;

    expect(revertResolve(b.editor, before, after, 'ins-1')).toEqual({ ok: true });
    expect(shape(b)).toEqual(withChange);
    expect(shape(a)).toEqual(withChange);
  });

  it('changes nothing when the edit is gone from the live document', () => {
    const before = snapshotDocument(b.editor)!;
    resolveTrackedChange(b.editor, { changeId: 'del-1', action: 'approve' }, true);
    const after = snapshotDocument(b.editor)!;
    // The author replaces the whole first paragraph meanwhile
    edit(a, () => {
      const text = ($getRoot().getChildAtIndex(0) as any).getFirstChild() as TextNode;
      if ($isTextNode(text)) ($getRoot().getChildAtIndex(0) as any).clear().append($createTextNode('Something else entirely, rewritten from scratch by the author.'));
    });
    const live = shape(a);
    const result = revertResolve(b.editor, before, after, 'del-1');
    expect(result.ok).toBe(false);
    expect(shape(a)).toEqual(live);
    expect(shape(b)).toEqual(live);
  });
});
