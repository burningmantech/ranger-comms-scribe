/**
 * Deletion markers in collaborative mode: which deletions make one, and which save stamps
 * it with a change id.
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { EditorRefPlugin } from '@lexical/react/LexicalEditorRefPlugin';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $nodesOfType,
  $setSelection,
  KEY_BACKSPACE_COMMAND,
  LexicalEditor,
  TextNode,
} from 'lexical';
import DeletionInterceptionPlugin from '../DeletionInterceptionPlugin';
import { $createDeletedTextNode, DeletedTextNode } from '../../nodes/DeletedTextNode';
import { $hasOrphanPendingMarkers, $removeOrphanPendingMarkers, $stampPendingMarkers } from '../TrackedChangesPlugin';
import { claimPendingMarkers, resetPendingMarkers, takeClaimedMarkers } from '../../collab/pendingMarkers';
import { extractTextFromLexical } from '../../../../utils/lexicalUtils';

let beforeText: string | null = null;

function setup(): LexicalEditor {
  const ref: { current: LexicalEditor | null } = { current: null };
  render(
    <LexicalComposer
      initialConfig={{
        namespace: 'deletion-interception-test',
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, DeletedTextNode],
        onError: (e: Error) => { throw e; },
      }}
    >
      <DeletionInterceptionPlugin
        enabled
        currentUserName="Alex"
        currentUserId="author-a"
        collabMode="yjs"
        getBeforeText={() => beforeText}
      />
      <EditorRefPlugin editorRef={ref} />
    </LexicalComposer>,
  );
  return ref.current!;
}

/** A saved document: a paragraph, then a list (the dev-site marker sat in a list item). */
function seed(editor: LexicalEditor): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    root.append($createParagraphNode().append($createTextNode('Key Things to Know:')));
    root.append($createListNode('bullet').append(
      $createListItemNode().append($createTextNode('Only claim what you need.')),
      $createListItemNode().append($createTextNode('Make sure you pay.')),
      $createListItemNode().append($createTextNode('Have fun.')),
    ));
    root.append($createParagraphNode().append($createTextNode('General Info:')));
  }, { discrete: true });
  beforeText = extractTextFromLexical(JSON.stringify(editor.getEditorState()));
}

function $lastTextOfItem(index: number): TextNode {
  const list = $getRoot().getChildAtIndex(1) as ListNode;
  const item = list.getChildAtIndex(index) as ListItemNode;
  const texts = item.getChildren().filter((n): n is TextNode => $isTextNode(n));
  return texts[texts.length - 1];
}

function caretAtEndOfItem(editor: LexicalEditor, index: number): void {
  editor.update(() => {
    const node = $lastTextOfItem(index);
    const sel = $createRangeSelection();
    sel.anchor.set(node.getKey(), node.getTextContentSize(), 'text');
    sel.focus.set(node.getKey(), node.getTextContentSize(), 'text');
    $setSelection(sel);
  }, { discrete: true });
}

function type(editor: LexicalEditor, text: string): void {
  editor.update(() => {
    const sel = $getSelection();
    if ($isRangeSelection(sel)) sel.insertText(text);
  }, { discrete: true });
}

/**
 * Backspace, then let the deferred marker update run. When the plugin lets the key through
 * (returns false: no other handler is registered here), the native delete is simulated
 * (jsdom has no Selection.modify for Lexical's own).
 */
async function backspace(editor: LexicalEditor): Promise<boolean> {
  let handled = false;
  await act(async () => {
    editor.update(() => {
      handled = editor.dispatchCommand(KEY_BACKSPACE_COMMAND, new KeyboardEvent('keydown', { key: 'Backspace' }));
      if (!handled) {
        const sel = $getSelection();
        if ($isRangeSelection(sel) && sel.isCollapsed() && $isTextNode(sel.anchor.getNode())) {
          const node = sel.anchor.getNode() as TextNode;
          const at = sel.anchor.offset;
          node.spliceText(at - 1, 1, '', true);
        }
      }
    }, { discrete: true });
    await new Promise((r) => setTimeout(r, 0));
  });
  return handled;
}

const markers = (editor: LexicalEditor) => editor.getEditorState().read(() =>
  $nodesOfType(DeletedTextNode).map((n) => ({ text: n.getDeletedText(), changeId: n.getChangeId(), pendingKey: n.getPendingKey(), authorId: n.getAuthorId() })));
const itemText = (editor: LexicalEditor, index: number) => editor.getEditorState().read(() =>
  ((($getRoot().getChildAtIndex(1) as ListNode).getChildAtIndex(index)) as ListItemNode).getTextContent());

describe('DeletionInterceptionPlugin (collaborative mode)', () => {
  beforeEach(() => resetPendingMarkers());

  it('deleting a character typed in the open transaction (in a list item) just deletes it: no marker', async () => {
    const editor = setup();
    seed(editor);
    caretAtEndOfItem(editor, 1);
    type(editor, '\\\\');
    expect(await backspace(editor)).toBe(false);
    expect(itemText(editor, 1)).toBe('Make sure you pay.\\');
    expect(markers(editor)).toEqual([]);
    expect(claimPendingMarkers('tx-1')).toBe(0);
  });

  it('deleting saved text in a list item makes a marker, even after typing in a later item', async () => {
    const editor = setup();
    seed(editor);
    caretAtEndOfItem(editor, 2);
    type(editor, '!');
    caretAtEndOfItem(editor, 1);
    expect(await backspace(editor)).toBe(true);
    expect(markers(editor)).toEqual([{ text: '.', changeId: '__pending_deletion__', pendingKey: expect.any(String), authorId: 'author-a' }]);
    expect(itemText(editor, 1)).toBe('Make sure you pay');
  });

  it('deleting a character typed in a paragraph just deletes it: no marker', async () => {
    const editor = setup();
    seed(editor);
    editor.update(() => {
      const node = ($getRoot().getLastChild() as any).getFirstChild() as TextNode;
      node.select(node.getTextContentSize(), node.getTextContentSize());
    }, { discrete: true });
    type(editor, ' x');
    expect(await backspace(editor)).toBe(false);
    expect(editor.getEditorState().read(() => $getRoot().getLastChild()!.getTextContent())).toBe('General Info: ');
    expect(markers(editor)).toEqual([]);
  });

  it('deleting saved text makes a marker, and only the save of its own transaction stamps it', async () => {
    const editor = setup();
    seed(editor);
    // A stray pending marker an earlier session left (no pending key).
    editor.update(() => {
      $lastTextOfItem(0).insertAfter($createDeletedTextNode({ changeId: '__pending_deletion__', deletedText: '\\', authorId: 'author-a' }));
    }, { discrete: true });

    caretAtEndOfItem(editor, 1);
    await backspace(editor); // deletes the saved "."
    const created = markers(editor).filter((m) => m.pendingKey);
    expect(created).toEqual([{ text: '.', changeId: '__pending_deletion__', pendingKey: expect.any(String), authorId: 'author-a' }]);
    expect(itemText(editor, 1)).toBe('Make sure you pay');

    // The transaction settles (claims its marker), another one starts, then the first is saved.
    expect(claimPendingMarkers('tx-1')).toBe(1);
    const keys = takeClaimedMarkers('tx-1');
    editor.update(() => { $stampPendingMarkers('change-1', keys); }, { discrete: true });

    expect(markers(editor)).toEqual(expect.arrayContaining([
      { text: '.', changeId: 'change-1', pendingKey: created[0].pendingKey, authorId: 'author-a' },
      { text: '\\', changeId: '__pending_deletion__', pendingKey: undefined, authorId: 'author-a' },
    ]));
    // A save without markers of its own (the cut) stamps nothing.
    editor.update(() => { $stampPendingMarkers('cut-change', takeClaimedMarkers('tx-2')); }, { discrete: true });
    expect(markers(editor).map((m) => m.changeId).sort()).toEqual(['__pending_deletion__', 'change-1']);
  });

  it('a marker created after a transaction settled belongs to the next transaction', async () => {
    const editor = setup();
    seed(editor);
    caretAtEndOfItem(editor, 1);
    await backspace(editor);
    expect(claimPendingMarkers('tx-1')).toBe(1);
    caretAtEndOfItem(editor, 1);
    await backspace(editor); // "y": the next transaction's
    expect(claimPendingMarkers('tx-2')).toBe(1);
    const k1 = takeClaimedMarkers('tx-1');
    const k2 = takeClaimedMarkers('tx-2');
    editor.update(() => { $stampPendingMarkers('change-1', k1); }, { discrete: true });
    editor.update(() => { $stampPendingMarkers('change-2', k2); }, { discrete: true });
    expect(markers(editor).map((m) => [m.text, m.changeId]).sort()).toEqual([['.', 'change-1'], ['y', 'change-2']]);
  });

  it('orphaned pending markers (no pending key) are found and removed; others are kept', async () => {
    const editor = setup();
    seed(editor);
    caretAtEndOfItem(editor, 1);
    await backspace(editor); // a new marker, still waiting for its save
    editor.update(() => {
      $lastTextOfItem(0).insertAfter($createDeletedTextNode({ changeId: '__pending_deletion__', deletedText: '\\', authorId: 'author-a' }));
      $lastTextOfItem(0).insertBefore($createDeletedTextNode({ changeId: 'some-change', deletedText: 'Only ', authorId: 'author-b' }));
    }, { discrete: true });
    expect(editor.getEditorState().read($hasOrphanPendingMarkers)).toBe(true);
    let removed = 0;
    editor.update(() => { removed = $removeOrphanPendingMarkers(); }, { discrete: true });
    expect(removed).toBe(1);
    expect(markers(editor).map((m) => m.text).sort()).toEqual(['.', 'Only ']);
    expect(editor.getEditorState().read($hasOrphanPendingMarkers)).toBe(false);
  });
});
