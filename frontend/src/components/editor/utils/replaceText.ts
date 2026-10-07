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

interface TextPoint {
  key: string;
  offset: number;
}

/**
 * Where the `occurrence`th (from 0) `search` is in the document: within one block, across
 * formatting, counting only text nodes (deletion markers aren't text). Optionally only its
 * characters from `trimStart` to `search.length - trimEnd`. Must run inside a read or update.
 */
function $findText(search: string, occurrence = 0, trimStart = 0, trimEnd = 0): { from: TextPoint; to: TextPoint } | null {
  const runs = new Map<string, { text: string; nodes: Array<{ node: TextNode; start: number }> }>();
  for (const node of $getRoot().getAllTextNodes()) {
    const block = blockOf(node);
    const key = block ? block.getKey() : 'root';
    const run = runs.get(key) || { text: '', nodes: [] };
    run.nodes.push({ node, start: run.text.length });
    run.text += node.getTextContent();
    runs.set(key, run);
  }
  let seen = 0;
  for (const run of Array.from(runs.values())) {
    for (let found = run.text.indexOf(search); found !== -1; found = run.text.indexOf(search, found + 1)) {
      if (seen++ < occurrence) continue;
      const index = found + trimStart;
      const end = found + search.length - trimEnd;
      const at = (offset: number, isEnd: boolean): TextPoint => {
        const hit = run.nodes.find(({ node, start }) => {
          const length = node.getTextContentSize();
          return isEnd ? offset > start && offset <= start + length : offset >= start && offset < start + length;
        }) || run.nodes[run.nodes.length - 1];
        return { key: hit.node.getKey(), offset: offset - hit.start };
      };
      return { from: at(index, false), to: index === end ? at(index, false) : at(end, true) };
    }
  }
  return null;
}

/** How many characters `a` and `b` share at the start and (not overlapping) at the end, in whole words. */
function sharedEnds(a: string, b: string): { start: number; end: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  // Change whole words ("Sunday" -> "Saturday", not "S[unday][aturday]")
  const word = /[\p{L}\p{N}]/u;
  while (start > 0 && word.test(a[start - 1]) && (word.test(a[start] || '') || word.test(b[start] || ''))) start--;
  while (end > 0 && word.test(a[a.length - end]) && (word.test(a[a.length - 1 - end] || '') || word.test(b[b.length - 1 - end] || ''))) end--;
  return { start, end };
}

/**
 * Replace the `occurrence`th (from 0) `search` in the editor with `replacement`, the way a person
 * would: select the words that differ, press Backspace, type. In the review editor that makes a
 * tracked change (the deletion plugin turns the Backspace into a deletion marker, and the typing is
 * an addition); elsewhere it is a plain edit. Returns false when the text isn't there.
 */
export async function replaceTextInEditor(
  editor: LexicalEditor,
  search: string,
  replacement: string,
  occurrence = 0,
): Promise<boolean> {
  if (!search || search === replacement) return false;
  const shared = sharedEnds(search, replacement);
  let found = false;
  editor.update(() => {
    const range = $findText(search, occurrence, shared.start, shared.end);
    if (!range) return;
    const selection = $createRangeSelection();
    selection.anchor.set(range.from.key, range.from.offset, 'text');
    selection.focus.set(range.to.key, range.to.offset, 'text');
    $setSelection(selection);
    found = true;
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

/** The DOM text node and offset for a point in a Lexical text node. */
function domPoint(editor: LexicalEditor, point: TextPoint): { node: Node; offset: number } | null {
  const element = editor.getElementByKey(point.key);
  if (!element) return null;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = point.offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length || 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
  }
  return null;
}

/** The screen rectangles (one per line) of the `occurrence`th `search` in the editor; empty when it isn't there. */
export function textRects(editor: LexicalEditor, search: string, occurrence = 0): DOMRect[] {
  let range: { from: TextPoint; to: TextPoint } | null = null;
  editor.getEditorState().read(() => {
    range = $findText(search, occurrence);
  });
  const found = range as { from: TextPoint; to: TextPoint } | null;
  if (!found) return [];
  const start = domPoint(editor, found.from);
  const end = domPoint(editor, found.to);
  if (!start || !end) return [];
  const dom = document.createRange();
  try {
    dom.setStart(start.node, start.offset);
    dom.setEnd(end.node, end.offset);
  } catch {
    return [];
  }
  return Array.from(dom.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
}
