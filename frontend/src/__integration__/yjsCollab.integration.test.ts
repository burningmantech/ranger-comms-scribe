/**
 * @jest-environment node
 */
/**
 * End-to-end check of collaborative editing against a running backend (contracts §9).
 *
 * Skipped unless YJS_E2E_API_URL is set, so the normal test run is unaffected. Run it with
 * a local backend in dev-bypass mode:
 *
 *   cd backend && PORT=8080 STORE_DRIVER=memory DEV_BYPASS_AUTH=true COLLAB_MODE=yjs \
 *     GOOGLE_CLIENT_ID=x TURNSTILESECRET=x PUBLIC_URL=http://localhost:8080/api \
 *     FRONTEND_URL=http://localhost:3000 npm run dev
 *   cd frontend && YJS_E2E_API_URL=http://localhost:8080/api CI=true \
 *     npx react-scripts test --watchAll=false --watchman=false src/__integration__
 *
 * Each client is a headless Lexical editor wired exactly like the browser editor:
 * - the same node set as CollaborativeEditor;
 * - the same provider (createSubmissionYjsProvider: fresh Y.Doc, connect: false);
 * - the same @lexical/yjs binding calls as CollaborationPlugin, including its bootstrap
 *   condition and $populateRootFromSavedContent as the seed.
 * A third "observer" client that only reads checks what the server's room doc holds.
 */
import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
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
import {
  Binding,
  createBinding,
  initLocalState,
  Provider,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
} from '@lexical/yjs';
import type { WebsocketProvider } from 'y-websocket';
import { ImageNode } from '../components/editor/nodes/ImageNode';
import { DeletedTextNode } from '../components/editor/nodes/DeletedTextNode';
import { $populateRootFromSavedContent } from '../components/editor/collab/YjsCollaboration';
import { createSubmissionYjsProvider } from '../services/yjsProvider';
import { registerCaretPreservation } from '../components/editor/collab/caretPreservation';

jest.mock('../config', () => ({
  API_URL: process.env.YJS_E2E_API_URL || 'http://localhost:8080/api',
  GOOGLE_CLIENT_ID: 'test',
  IS_PRODUCTION: false,
  DEBUG_LOGGING_ENABLED: false,
}));

const API = process.env.YJS_E2E_API_URL;
const describeE2E = API ? describe : describe.skip;

const NODES = [
  HeadingNode, QuoteNode, ListItemNode, ListNode, CodeHighlightNode, CodeNode,
  TableNode, TableCellNode, TableRowNode, LinkNode, ImageNode, DeletedTextNode,
];

/** Saved content: two paragraphs (one with bold text), a heading, a deletion marker with formatted segments, an image. */
const SEED = JSON.stringify({
  root: {
    type: 'root', version: 1, format: '', indent: 0, direction: 'ltr',
    children: [
      {
        type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', textFormat: 0, textStyle: '',
        children: [
          { type: 'text', version: 1, text: 'The quick brown fox', format: 0, style: '', mode: 'normal', detail: 0 },
          {
            type: 'deleted-text', version: 1, changeId: 'change-1', deletedText: 'lazy',
            authorName: 'Dev Admin', authorColor: '#1a73e8', authorId: 'dev-admin',
            isBlockLevel: false, formattedSegments: [{ text: 'lazy', format: 1, style: '' }],
          },
          { type: 'text', version: 1, text: ' jumps.', format: 1, style: '', mode: 'normal', detail: 0 },
        ],
      },
      {
        type: 'heading', tag: 'h2', version: 1, format: '', indent: 0, direction: 'ltr',
        children: [{ type: 'text', version: 1, text: 'Second line', format: 0, style: '', mode: 'normal', detail: 0 }],
      },
      {
        type: 'image', version: 1, format: '', indent: 0, direction: null,
        src: 'https://example.org/a.png', altText: 'A', width: 100, height: 50, alignment: 'none',
        children: [],
      },
      {
        type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', textFormat: 0, textStyle: '',
        children: [{ type: 'text', version: 1, text: 'Third paragraph here', format: 0, style: '', mode: 'normal', detail: 0 }],
      },
    ],
  },
});

interface Client {
  name: string;
  editor: LexicalEditor;
  binding: Binding;
  provider: Provider;
  ws: WebsocketProvider;
  doc: Y.Doc;
  bootstrapped: number;
  close: () => void;
}

const clients: Client[] = [];
let roomCounter = 0;
const newRoom = () => `yjs-e2e-${Date.now()}-${++roomCounter}`;

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A headless editor bound to the room the way CollaborationPlugin binds the browser editor. */
function connectClient(name: string, room: string, opts: { seed?: string; bootstrap?: boolean; sessionId?: string } = {}): Client {
  const editor = createEditor({ namespace: `e2e-${name}`, nodes: NODES, onError: (e) => { throw e; } });
  const docMap = new Map<string, Y.Doc>();
  const { provider, websocketProvider, doc } = createSubmissionYjsProvider(room, docMap, opts.sessionId ?? `dev-session-${name}`, {
    apiUrl: API,
    WebSocketPolyfill: WebSocket,
  });
  const binding = createBinding(editor, provider, room, doc, docMap);
  const client: Client = { name, editor, binding, provider, ws: websocketProvider, doc, bootstrapped: 0, close: () => {} };
  const noCursors = () => {};

  const onYjs = (events: Array<Y.YEvent<any>>, transaction: Y.Transaction) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexical(binding, provider, events as any, transaction.origin instanceof Y.UndoManager, noCursors);
    }
  };
  binding.root.getSharedType().observeDeep(onYjs);
  // As YjsSession does: note whether the update being synced is the user's own edit
  // (registered before the sync listener, so it runs first).
  let ownEdit = false;
  const removeTagListener = editor.registerUpdateListener(({ tags }) => {
    ownEdit = !tags.has('collaboration') && !tags.has('history-merge') && !tags.has('historic');
  });
  const removeUpdateListener = editor.registerUpdateListener(
    ({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      if (!tags.has('skip-collab')) {
        syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
      }
    },
  );
  initLocalState(provider, name, '#123456', false, {});

  const shouldBootstrap = opts.bootstrap !== false;
  const onSync = (isSynced: boolean) => {
    // CollaborationPlugin's bootstrap condition, verbatim.
    if (shouldBootstrap && isSynced && binding.root.isEmpty() && (binding.root as any)._xmlText._length === 0) {
      client.bootstrapped++;
      editor.update(() => {
        if ($getRoot().isEmpty()) $populateRootFromSavedContent(editor, opts.seed ?? '');
      }, { tag: 'history-merge', discrete: true });
    }
  };
  websocketProvider.on('sync', onSync);
  // As in the browser editor (headless clients always count as focused).
  const removeCaret = registerCaretPreservation({
    editor,
    doc,
    isRemoteOrigin: (origin) => origin === websocketProvider,
    getLocalAwarenessState: () => websocketProvider.awareness.getLocalState() as any,
    isFocused: () => true,
    isOwnEdit: (tr) => ownEdit && tr.origin === binding,
  });
  websocketProvider.connect();

  client.close = () => {
    removeCaret();
    removeTagListener();
    websocketProvider.off('sync', onSync);
    binding.root.getSharedType().unobserveDeep(onYjs);
    removeUpdateListener();
    websocketProvider.destroy();
    doc.destroy();
  };
  clients.push(client);
  return client;
}

/**
 * The editor state as JSON, without `direction`: @lexical/yjs doesn't sync it (`__dir` is
 * excluded) because the browser recomputes it while rendering; a headless editor only
 * keeps whatever the seed JSON said.
 */
const json = (c: Client) =>
  JSON.stringify(c.editor.getEditorState().toJSON(), (key, value) => (key === 'direction' ? undefined : value));
const text = (c: Client) => c.editor.getEditorState().read(() => $getRoot().getTextContent());
const synced = (...cs: Client[]) => cs.every((c) => c.ws.synced);
const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

async function converge(...cs: Client[]): Promise<void> {
  try {
    await waitFor(() => synced(...cs) && cs.every((c) => json(c) === json(cs[0])), `${cs.map((c) => c.name).join('/')} to converge`);
  } catch (error) {
    const state = cs.map((c) => `${c.name}: synced=${c.ws.synced} wsconnected=${c.ws.wsconnected} bootstrapped=${c.bootstrapped} text=${JSON.stringify(text(c))}`);
    throw new Error(`${(error as Error).message}\n${state.join('\n')}`);
  }
}

function edit(c: Client, fn: () => void): void {
  c.editor.update(fn, { discrete: true });
}

/** The TextNode containing `needle` in top-level block `blockIndex`, and its offset there. */
function $findText(blockIndex: number, needle: string): { node: TextNode; offset: number } {
  const block = $getRoot().getChildAtIndex(blockIndex) as any;
  for (const child of block.getChildren()) {
    if ($isTextNode(child)) {
      const i = child.getTextContent().indexOf(needle);
      if (i !== -1) return { node: child, offset: i };
    }
  }
  throw new Error(`"${needle}" not found in block ${blockIndex}`);
}

function $selectRange(node: TextNode, start: number, end: number): void {
  const selection = $createRangeSelection();
  selection.anchor.set(node.getKey(), start, 'text');
  selection.focus.set(node.getKey(), end, 'text');
  $setSelection(selection);
}

async function seededPair(): Promise<[Client, Client, Client, string]> {
  const room = newRoom();
  const a = connectClient('A', room, { seed: SEED });
  await waitFor(() => synced(a), 'A synced');
  const b = connectClient('B', room, { seed: SEED, sessionId: 'dev-session-user2' });
  await converge(a, b);
  const observer = connectClient('observer', room, { bootstrap: false });
  await converge(a, b, observer);
  return [a, b, observer, room];
}

afterEach(() => {
  while (clients.length) clients.pop()!.close();
});

describeE2E('Yjs collaboration against the running backend', () => {
  jest.setTimeout(30000);

  it('seeds an empty room exactly once when two clients join at the same time', async () => {
    const room = newRoom();
    const a = connectClient('A', room, { seed: SEED });
    const b = connectClient('B', room, { seed: SEED, sessionId: 'dev-session-user2' });
    await converge(a, b);
    expect(a.bootstrapped + b.bootstrapped).toBe(1);
    expect(countOf(text(a), 'The quick brown fox')).toBe(1);
    expect(countOf(text(a), 'Third paragraph here')).toBe(1);

    const observer = connectClient('observer', room, { bootstrap: false });
    await converge(a, b, observer);
    expect(observer.bootstrapped).toBe(0);
    expect(countOf(text(observer), 'Second line')).toBe(1);
  });

  it('round-trips the saved document through Yjs (deletion markers with formatting, images, headings)', async () => {
    const [, , observer] = await seededPair();
    const seeded = JSON.parse(SEED).root.children;
    const received = JSON.parse(json(observer)).root.children;
    expect(received.map((n: any) => n.type)).toEqual(['paragraph', 'heading', 'image', 'paragraph']);
    const marker = received[0].children.find((n: any) => n.type === 'deleted-text');
    expect(marker).toEqual(expect.objectContaining({
      changeId: 'change-1', deletedText: 'lazy', authorName: 'Dev Admin', authorColor: '#1a73e8',
      authorId: 'dev-admin', formattedSegments: [{ text: 'lazy', format: 1, style: '' }],
    }));
    expect(received[0].children[2]).toEqual(expect.objectContaining({ text: ' jumps.', format: 1 }));
    expect(received[1]).toEqual(expect.objectContaining({ tag: 'h2' }));
    expect(received[2]).toEqual(expect.objectContaining({ src: seeded[2].src, altText: 'A' }));
  });

  it('lets the next client seed when the seeder leaves without seeding', async () => {
    const room = newRoom();
    // A seeder that syncs but never sends content (no bootstrap), then leaves.
    const stuck = connectClient('stuck', room, { bootstrap: false });
    await waitFor(() => synced(stuck), 'stuck seeder synced');
    const b = connectClient('B', room, { seed: SEED, sessionId: 'dev-session-user2' });
    await new Promise((r) => setTimeout(r, 300));
    expect(b.ws.synced).toBe(false); // held while someone else is the seeder
    stuck.close();
    clients.splice(clients.indexOf(stuck), 1);
    await waitFor(() => synced(b) && text(b).includes('Third paragraph here'), 'B to seed after promotion');
    expect(b.bootstrapped).toBe(1);

    const observer = connectClient('observer', room, { bootstrap: false });
    await converge(b, observer);
    expect(countOf(text(observer), 'The quick brown fox')).toBe(1);
  });

  it('merges concurrent typing in the same paragraph (offline edits, then reconnect)', async () => {
    const [a, b, observer] = await seededPair();
    a.ws.disconnect();
    b.ws.disconnect();
    edit(a, () => { const { node } = $findText(0, 'The quick'); node.spliceText(0, 0, 'AAA ', false); });
    edit(b, () => { const { node, offset } = $findText(0, 'brown fox'); node.spliceText(offset + 'brown fox'.length, 0, ' BBB', false); });
    a.ws.connect();
    b.ws.connect();
    await converge(a, b, observer);
    const t = text(observer);
    expect(countOf(t, 'AAA ')).toBe(1);
    expect(countOf(t, ' BBB')).toBe(1);
    expect(t.startsWith('AAA The quick brown fox BBB')).toBe(true);
  });

  it('merges typing at the same position', async () => {
    const [a, b, observer] = await seededPair();
    a.ws.disconnect();
    b.ws.disconnect();
    edit(a, () => { const { node, offset } = $findText(0, 'quick'); node.spliceText(offset, 0, 'xx', false); });
    edit(b, () => { const { node, offset } = $findText(0, 'quick'); node.spliceText(offset, 0, 'yy', false); });
    a.ws.connect();
    b.ws.connect();
    await converge(a, b, observer);
    const t = text(observer);
    expect(countOf(t, 'xx')).toBe(1);
    expect(countOf(t, 'yy')).toBe(1);
    expect(t).toMatch(/The (xxyy|yyxx)quick brown fox/);
  });

  it('converges on a paragraph split (Enter) with typing in the same paragraph', async () => {
    const [a, b, observer] = await seededPair();
    const blocksBefore = JSON.parse(json(a)).root.children.length;
    a.ws.disconnect();
    b.ws.disconnect();
    edit(a, () => {
      const { node, offset } = $findText(3, 'paragraph');
      $selectRange(node, offset, offset);
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error('no selection');
      selection.insertParagraph();
    });
    // B types (caret at the end of the paragraph) while offline.
    edit(b, () => { const { node } = $findText(3, 'here'); $selectRange(node, node.getTextContentSize(), node.getTextContentSize()); });
    for (const ch of ' and more') edit(b, () => { const sel = $getSelection(); if ($isRangeSelection(sel)) sel.insertText(ch); });
    a.ws.connect();
    b.ws.connect();
    await converge(a, b, observer);
    const blocks = JSON.parse(json(observer)).root.children;
    expect(blocks.length).toBe(blocksBefore + 1);
    const texts = observer.editor.getEditorState().read(() => $getRoot().getChildren().map((n) => n.getTextContent()));
    expect(countOf(texts.join('\n'), ' and more')).toBe(1);
    // @lexical/yjs syncs the split as delete + re-insert, so Yjs leaves B's offline text at
    // the split point; B's caret preservation moves its own just-typed text after the moved text.
    expect(texts.slice(3)).toEqual(['Third ', 'paragraph here and more']);
  });

  it('converges on bold of a word with typing inside that word', async () => {
    const [a, b, observer] = await seededPair();
    a.ws.disconnect();
    b.ws.disconnect();
    edit(a, () => {
      const { node, offset } = $findText(0, 'quick');
      $selectRange(node, offset, offset + 'quick'.length);
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error('no selection');
      selection.formatText('bold');
    });
    edit(b, () => { const { node, offset } = $findText(0, 'quick'); $selectRange(node, offset + 2, offset + 2); });
    for (const ch of 'ZZ') edit(b, () => { const sel = $getSelection(); if ($isRangeSelection(sel)) sel.insertText(ch); });
    a.ws.connect();
    b.ws.connect();
    await converge(a, b, observer);
    const t = text(observer);
    expect(countOf(t, 'ZZ')).toBe(1);
    const firstBlock = JSON.parse(json(observer)).root.children[0].children;
    expect(firstBlock.filter((n: any) => n.type === 'text' && n.format & 1).map((n: any) => n.text).join('|')).toContain('qu');
    // Bolding splits the text node (delete + re-insert); B's own just-typed text is moved
    // back inside the word by its caret preservation.
    expect(t.startsWith('The quZZick brown fox')).toBe(true);
  });

  it('a remote Enter before your caret in your paragraph keeps your caret where you were typing', async () => {
    const [a, b, observer] = await seededPair();
    edit(b, () => { const { node } = $findText(3, 'here'); $selectRange(node, node.getTextContentSize(), node.getTextContentSize()); });
    edit(a, () => {
      const { node, offset } = $findText(3, 'paragraph');
      $selectRange(node, offset, offset);
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error('no selection');
      selection.insertParagraph();
    });
    await converge(a, b, observer);
    edit(b, () => { const selection = $getSelection(); if ($isRangeSelection(selection)) selection.insertText(' typed'); });
    await converge(a, b, observer);
    const texts = observer.editor.getEditorState().read(() => $getRoot().getChildren().map((n) => n.getTextContent()));
    expect(texts.slice(3)).toEqual(['Third ', 'paragraph here typed']);
  });

  // Real-time typing: one keystroke at a time while the other user edits, 10 runs each.
  const RUNS = Number(process.env.YJS_E2E_RUNS || 10);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function typeChars(c: Client, chars: string, delayMs: number): Promise<void> {
    for (const ch of chars) {
      edit(c, () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error(`${c.name} has no selection`);
        selection.insertText(ch);
      });
      await sleep(delayMs);
    }
  }
  const blockTexts = (c: Client) => c.editor.getEditorState().read(() => $getRoot().getChildren().map((n) => n.getTextContent()));

  for (let run = 1; run <= RUNS; run++) {
    it(`same position, typed at the same time, stays two contiguous blocks (run ${run})`, async () => {
      const [a, b, observer] = await seededPair();
      edit(a, () => { const { node, offset } = $findText(3, 'paragraph'); $selectRange(node, offset, offset); });
      edit(b, () => { const { node, offset } = $findText(3, 'paragraph'); $selectRange(node, offset, offset); });
      await Promise.all([typeChars(a, 'xxxx', 25), typeChars(b, 'yyyy', 25)]);
      await converge(a, b, observer);
      expect(blockTexts(observer)[3]).toMatch(/^Third (xxxxyyyy|yyyyxxxx)paragraph here$/);
    });

    it(`Enter before the other user's typing: their characters continue where they were typing (run ${run})`, async () => {
      const [a, b, observer] = await seededPair();
      edit(a, () => { const { node } = $findText(3, 'here'); $selectRange(node, node.getTextContentSize(), node.getTextContentSize()); });
      edit(b, () => { const { node, offset } = $findText(3, 'paragraph'); $selectRange(node, offset, offset); });
      await Promise.all([
        typeChars(a, 'ZZZZZZZZ', 30),
        (async () => {
          await sleep(70 + run * 7); // vary where the split lands in A's typing
          edit(b, () => { const sel = $getSelection(); if ($isRangeSelection(sel)) sel.insertParagraph(); });
        })(),
      ]);
      await converge(a, b, observer);
      expect(blockTexts(observer).slice(3)).toEqual(['Third ', 'paragraph hereZZZZZZZZ']);
    });

    it(`bold inside the word the other user is typing in: their characters stay in the word (run ${run})`, async () => {
      const [a, b, observer] = await seededPair();
      edit(a, () => { const { node, offset } = $findText(0, 'quick'); $selectRange(node, offset + 2, offset + 2); });
      await Promise.all([
        typeChars(a, 'QQQQQQ', 30),
        (async () => {
          await sleep(60 + run * 7);
          edit(b, () => {
            const t = $getRoot().getChildAtIndex(0)!.getTextContent();
            const start = t.indexOf('qu');
            const end = t.indexOf('ick', start) + 3;
            const nodes = ($getRoot().getChildAtIndex(0) as any).getChildren().filter((n: any) => $isTextNode(n));
            const node = nodes[0] as TextNode;
            $selectRange(node, start, end);
            const sel = $getSelection();
            if ($isRangeSelection(sel)) sel.formatText('bold');
          });
        })(),
      ]);
      await converge(a, b, observer);
      expect(text(observer)).toContain('The quQQQQQQick brown fox');
    });
  }

  it('merges edits made by both clients in the same tick while connected', async () => {
    const [a, b, observer] = await seededPair();
    edit(a, () => { const { node } = $findText(1, 'Second'); node.spliceText(0, 0, '[A]', false); });
    edit(b, () => { const { node } = $findText(1, 'line'); node.spliceText(node.getTextContentSize(), 0, '[B]', false); });
    edit(a, () => { $getRoot().append($createParagraphNode().append($createTextNode('appended by A'))); });
    await converge(a, b, observer);
    const t = text(observer);
    expect(countOf(t, '[A]Second line[B]')).toBe(1);
    expect(countOf(t, 'appended by A')).toBe(1);
  });
});
