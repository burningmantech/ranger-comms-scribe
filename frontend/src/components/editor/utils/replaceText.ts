import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  ElementNode,
  KEY_BACKSPACE_COMMAND,
  LexicalEditor,
  TextNode,
} from 'lexical';

/** The block a text node belongs to (its nearest non-inline ancestor). */
function blockOf(node: TextNode): ElementNode | null {
  let parent = node.getParent();
  while (parent && parent.isInline()) parent = parent.getParent();
  return parent;
}

/**
 * Select the first `search` in the editor (within one block, across formatting), or only its
 * characters from `trimStart` to `search.length - trimEnd`, and return whether it was found.
 * Must run inside editor.update.
 */
function $selectText(search: string, trimStart = 0, trimEnd = 0): boolean {
  const runs = new Map<string, { text: string; nodes: Array<{ node: TextNode; start: number }> }>();
  for (const node of $getRoot().getAllTextNodes()) {
    const block = blockOf(node);
    const key = block ? block.getKey() : 'root';
    const run = runs.get(key) || { text: '', nodes: [] };
    run.nodes.push({ node, start: run.text.length });
    run.text += node.getTextContent();
    runs.set(key, run);
  }
  for (const run of Array.from(runs.values())) {
    const found = run.text.indexOf(search);
    if (found === -1) continue;
    const index = found + trimStart;
    const end = found + search.length - trimEnd;
    const at = (offset: number, isEnd: boolean) => {
      const hit = run.nodes.find(({ node, start }) => {
        const length = node.getTextContentSize();
        return isEnd ? offset > start && offset <= start + length : offset >= start && offset < start + length;
      })!;
      return { key: hit.node.getKey(), offset: offset - hit.start };
    };
    const from = at(index, false);
    const to = at(end, true);
    const selection = $createRangeSelection();
    selection.anchor.set(from.key, from.offset, 'text');
    selection.focus.set(to.key, to.offset, 'text');
    $setSelection(selection);
    return true;
  }
  return false;
}

/** How many characters `a` and `b` share at the start and (not overlapping) at the end. */
function sharedEnds(a: string, b: string): { start: number; end: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { start, end };
}

/**
 * Replace the first `search` in the editor with `replacement`, the way a person would: select the
 * part that differs, press Backspace, type. In the review editor that makes a tracked change (the
 * deletion plugin turns the Backspace into a deletion marker, and the typing is an addition);
 * elsewhere it is a plain edit. Returns false when the text isn't there.
 */
export async function replaceTextInEditor(editor: LexicalEditor, search: string, replacement: string): Promise<boolean> {
  if (!search || search === replacement) return false;
  const shared = sharedEnds(search, replacement);
  let found = false;
  editor.update(() => {
    found = $selectText(search, shared.start, shared.end);
  }, { discrete: true });
  if (!found) return false;
  if (search.length - shared.start - shared.end > 0) {
    editor.update(() => {
      editor.dispatchCommand(KEY_BACKSPACE_COMMAND, new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true }));
    }, { discrete: true });
    // The deletion plugin makes its marker in a deferred update
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) selection.insertText(replacement.slice(shared.start, replacement.length - shared.end));
  }, { discrete: true });
  return true;
}
