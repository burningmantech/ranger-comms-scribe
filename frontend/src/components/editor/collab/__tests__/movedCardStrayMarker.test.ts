/**
 * The Moved-card reject from the dev site (feat/review-ui), on the captured data.
 *
 * The author cut "New for 2026:" and its list and pasted it lower down (a deletion and an
 * insertion: one "Moved" card). The live document also held a stray deletion marker ("\",
 * typed and backspaced earlier) that had been stamped with the cut's change id. Rejecting
 * the card took the legacy marker path because of it, ran 23 phantom format reverts, and
 * restored nothing.
 *
 * Here the reviewer's editor and the author's editor are headless editors bound through
 * Yjs; the reject goes through the same detail TrackedChangesEditor builds and the same
 * resolve handler, deletion first, then insertion (the Moved card's order).
 */
import * as Y from 'yjs';
import { $getRoot, $parseSerializedNode, createEditor, LexicalEditor } from 'lexical';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { LinkNode } from '@lexical/link';
import { createBinding, Provider, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from '@lexical/yjs';
import { DeletedTextNode } from '../../nodes/DeletedTextNode';
import { ImageNode } from '../../nodes/ImageNode';
import { resolveTrackedChange, ResolveTrackedChangeDetail } from '../../plugins/TrackedChangesPlugin';
import { $exportNodeJSON } from '../rejectRestore';
import { trackProvenance } from '../provenance';
import { buildResolveHints } from '../../../../utils/resolveHints';
import fixture from './fixtures/movedCardStrayMarker.json';

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

const flush = (c: Client) => c.editor.update(() => {}, { discrete: true });

function load(c: Client, json: string): void {
  const blocks = JSON.parse(json).root.children;
  c.editor.update(() => {
    const root = $getRoot();
    root.clear();
    root.append(...blocks.map((b: any) => $parseSerializedNode(b)));
  }, { discrete: true, tag: 'history-merge' });
}

function liveBlocks(c: Client): any[] {
  flush(c);
  return c.editor.getEditorState().read(() => $getRoot().getChildren().map($exportNodeJSON));
}

/** Properties that differ between equal documents (computed or editor-local). */
const IGNORED = new Set(['direction', 'textFormat', 'textStyle']);
function normalize(value: any, dropMarkers: boolean): any {
  if (Array.isArray(value)) {
    return value.filter((v) => !(dropMarkers && v && v.type === 'deleted-text')).map((v) => normalize(v, dropMarkers));
  }
  if (value === null || typeof value !== 'object') return value;
  const out: any = {};
  for (const k of Object.keys(value).sort()) {
    if (!IGNORED.has(k) && value[k] !== undefined) out[k] = normalize(value[k], dropMarkers);
  }
  return out;
}

function markers(blocks: any[]): any[] {
  const found: any[] = [];
  const walk = (n: any) => {
    if (n?.type === 'deleted-text') found.push(n);
    (n?.children || []).forEach(walk);
  };
  blocks.forEach(walk);
  return found;
}

type FixtureChange = typeof fixture.deletion;

/** The detail TrackedChangesEditor's handleChangeDecision dispatches for a collaborative reject. */
function rejectDetail(change: FixtureChange): ResolveTrackedChangeDetail {
  const hints = buildResolveHints(change, { collab: true });
  return {
    changeId: change.id,
    action: 'reject',
    ...hints,
    pendingAuthorIds: [change.changedBy],
    richTextOldValue: change.richTextOldValue,
    richTextNewValue: change.richTextNewValue,
  };
}

describe('Moved card reject on the captured dev-site document', () => {
  let author: Client;
  let reviewer: Client;
  beforeEach(() => {
    author = client('author');
    reviewer = client('reviewer');
    connect(author, reviewer);
    load(author, fixture.live);
    expect(normalize(liveBlocks(reviewer), false)).toEqual(normalize(JSON.parse(fixture.live).root.children, false));
  });

  it('the live document has the stray marker stamped with the cut\'s id', () => {
    const found = markers(liveBlocks(reviewer));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ deletedText: '\\', changeId: fixture.deletion.id });
  });

  it('rejecting the deletion, then the insertion, restores the document before the cut', () => {
    const del = rejectDetail(fixture.deletion);
    resolveTrackedChange(reviewer.editor, del, true);
    expect(del.result).toEqual({ restored: true, method: 'context' });

    const ins = rejectDetail(fixture.insertion);
    resolveTrackedChange(reviewer.editor, ins, true);
    expect(ins.result).toEqual({ restored: true, method: 'context' });

    // The document before the cut, without the stray marker: it stood for text that was
    // never in a saved version, and it belonged to the rejected change, so the reject
    // removes it. Nothing else changed, except at the paste site: the captured insertion
    // record's before-state holds the empty paragraph with the pasted line break still in
    // it (a local-edit tracker artifact, fixed for new records: see the "pasted over an
    // empty paragraph" test in rejectRestoreCollab.test.ts), and the reject restores the
    // record faithfully.
    const PASTE_SITE = 12;
    const expected = normalize(JSON.parse(fixture.deletion.richTextOldValue).root.children, true);
    expect(expected[PASTE_SITE]).toMatchObject({ type: 'paragraph', children: [] });
    const recordedBefore = JSON.parse(fixture.insertion.richTextOldValue).root.children[PASTE_SITE - 1];
    expect(recordedBefore.children.map((n: any) => n.type)).toEqual(['linebreak', 'listitem', 'listitem']);
    for (const c of [reviewer, author]) {
      const blocks = normalize(liveBlocks(c), false);
      expect(markers(blocks)).toEqual([]);
      expect(blocks.length).toBe(expected.length);
      expect(blocks[PASTE_SITE]).toEqual({ ...expected[PASTE_SITE], children: [{ type: 'linebreak', version: 1 }] });
      expect([...blocks.slice(0, PASTE_SITE), ...blocks.slice(PASTE_SITE + 1)])
        .toEqual([...expected.slice(0, PASTE_SITE), ...expected.slice(PASTE_SITE + 1)]);
    }
  });

  it('computes no format changes in collaborative mode', () => {
    expect(buildResolveHints(fixture.deletion, { collab: true }).formatChanges).toEqual([]);
  });

  it('legacy hints: no phantom block changes for the blocks the cut shifted', () => {
    const { formatChanges } = buildResolveHints(fixture.deletion, { collab: false });
    expect(formatChanges.filter((f) => f.type === 'block')).toEqual([]);
  });
});
