import { $getRoot, createEditor, LexicalEditor } from 'lexical';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { LinkNode } from '@lexical/link';
import { ImageNode } from '../../nodes/ImageNode';
import { DeletedTextNode } from '../../nodes/DeletedTextNode';
import { $populateRootFromSavedContent, classifyCollabUpdate } from '../YjsCollaboration';
import { yjsServerUrl, yjsWebSocketBase } from '../../../../services/yjsProvider';

function seed(content: string): { editor: LexicalEditor; blocks: string[]; types: string[] } {
  const editor = createEditor({
    namespace: 'seed-test',
    nodes: [HeadingNode, QuoteNode, ListItemNode, ListNode, LinkNode, ImageNode, DeletedTextNode],
    onError: (e) => { throw e; },
  });
  editor.update(() => $populateRootFromSavedContent(editor, content), { discrete: true });
  return editor.getEditorState().read(() => ({
    editor,
    blocks: $getRoot().getChildren().map((n) => n.getTextContent()),
    types: $getRoot().getChildren().map((n) => n.getType()),
  }));
}

describe('classifyCollabUpdate', () => {
  it('routes updates by origin', () => {
    expect(classifyCollabUpdate(new Set(['collaboration']))).toBe('remote');
    expect(classifyCollabUpdate(new Set(['collaboration', 'skip-scroll-into-view']))).toBe('remote');
    expect(classifyCollabUpdate(new Set(['history-merge']))).toBe('baseline');
    expect(classifyCollabUpdate(new Set(['tracked-changes-resolve']))).toBe('baseline');
    expect(classifyCollabUpdate(new Set(['tracked-changes-decoration']))).toBe('baseline');
    expect(classifyCollabUpdate(new Set(['skip-collab']))).toBe('ignore');
    // Yjs UndoManager undoes the local user's own edits
    expect(classifyCollabUpdate(new Set(['historic']))).toBe('local');
    expect(classifyCollabUpdate(new Set())).toBe('local');
  });
});

describe('$populateRootFromSavedContent (the one-time seed)', () => {
  it('loads Lexical JSON, including headings and deletion markers', () => {
    const json = JSON.stringify({
      root: {
        type: 'root', version: 1, format: '', indent: 0, direction: 'ltr',
        children: [
          { type: 'heading', tag: 'h1', version: 1, format: '', indent: 0, direction: 'ltr', children: [{ type: 'text', version: 1, text: 'Title', format: 0, style: '', mode: 'normal', detail: 0 }] },
          {
            type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', children: [
              { type: 'text', version: 1, text: 'Body', format: 0, style: '', mode: 'normal', detail: 0 },
              { type: 'deleted-text', version: 1, changeId: 'c1', deletedText: 'gone', authorId: 'u1' },
            ],
          },
        ],
      },
    });
    const { editor, blocks, types } = seed(json);
    expect(types).toEqual(['heading', 'paragraph']);
    expect(blocks).toEqual(['Title', 'Body']); // deletion markers have no text content
    const exported = JSON.stringify(editor.getEditorState().toJSON());
    expect(exported).toContain('"authorId":"u1"');
  });

  it('loads HTML and plain text', () => {
    expect(seed('<p>One <b>two</b></p><p>Three</p>').blocks).toEqual(['One two', 'Three']);
    expect(seed('line 1\nline 2').blocks).toEqual(['line 1', 'line 2']);
  });

  it('gives an empty document one empty paragraph, never placeholder text', () => {
    expect(seed('')).toEqual(expect.objectContaining({ blocks: [''], types: ['paragraph'] }));
  });

  it('never throws on content it cannot parse (a failed seed would leave the room unseeded)', () => {
    const broken = '{"root":{"children":[{"type":"no-such-node","version":1}]}}';
    expect(() => seed(broken)).not.toThrow();
    expect(seed(broken).blocks.length).toBeGreaterThan(0);
  });
});

describe('yjs socket URL', () => {
  it('uses API_URL\'s origin with ws/wss and the contract path', () => {
    expect(yjsWebSocketBase('https://app.scrivenly.com/api')).toBe('wss://app.scrivenly.com');
    expect(yjsWebSocketBase('http://localhost:8080/api')).toBe('ws://localhost:8080');
    expect(yjsServerUrl('https://app.scrivenly.com/api')).toBe('wss://app.scrivenly.com/api/ws/yjs/submissions');
  });
});
