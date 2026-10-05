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
});
