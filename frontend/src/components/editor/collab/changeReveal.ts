/**
 * Linking review cards to the text in the editor:
 *
 *  - revealChangeInEditor: scroll the editor to a change and highlight it briefly. The
 *    change is located in the live document with the reject locator (locateChange), so it
 *    works for any change with rich text, including cuts and multi-paragraph pastes.
 *  - changeIdAtPoint: which change's highlighted text is under the mouse (deletion
 *    markers carry data-change-id; additions are CSS Custom Highlight ranges named
 *    `tracked-change-<id>` by TrackedChangesPlugin).
 */
import { $getRoot, LexicalEditor } from 'lexical';
import { $exportNodeJSON, $resolveUnitPoint, ChangeLocation, LexicalUnitPoint, locateChange } from './rejectRestore';

/** CSS Custom Highlight used for the brief "here it is" flash. */
export const FOCUS_HIGHLIGHT = 'tce-change-focus';
/** Class added to a block for a change with nothing left in the document (a deletion). */
export const ANCHOR_FLASH_CLASS = 'tce-change-anchor-flash';
const FLASH_MS = 2000;

const CHANGE_HIGHLIGHT_PREFIX = 'tracked-change-';

const highlightsSupported = (): boolean =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (window as any).Highlight === 'function';

/** Locate a change in the editor's current document. */
export function locateChangeInEditor(editor: LexicalEditor, before: string, after: string): ChangeLocation | null {
  const live = editor.getEditorState().read(() => $getRoot().getChildren().map($exportNodeJSON));
  return locateChange(before, after, live);
}

function firstTextNode(el: Node): Text | null {
  if (el.nodeType === Node.TEXT_NODE) return el as Text;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

/** Set one boundary of a DOM range at a resolved Lexical point. False when it has no DOM. */
function setBoundary(editor: LexicalEditor, range: Range, point: LexicalUnitPoint, which: 'start' | 'end'): boolean {
  const el = editor.getElementByKey(point.key);
  if (!el) return false;
  if (point.type === 'text') {
    const text = firstTextNode(el);
    if (!text) {
      if (which === 'start') range.setStartBefore(el);
      else range.setEndAfter(el);
      return true;
    }
    const offset = Math.min(point.offset, text.length);
    if (which === 'start') range.setStart(text, offset);
    else range.setEnd(text, offset);
    return true;
  }
  if (which === 'start') range.setStartBefore(el);
  else range.setEndAfter(el);
  return true;
}

let flashTimer: ReturnType<typeof setTimeout> | null = null;

function flashRange(range: Range, fallbackEl: HTMLElement | null): void {
  if (flashTimer) clearTimeout(flashTimer);
  if (highlightsSupported()) {
    (CSS as any).highlights.set(FOCUS_HIGHLIGHT, new (window as any).Highlight(range));
    flashTimer = setTimeout(() => {
      (CSS as any).highlights.delete(FOCUS_HIGHLIGHT);
      flashTimer = null;
    }, FLASH_MS);
  } else if (fallbackEl) {
    flashElement(fallbackEl, 'tracked-change-active');
  }
}

function flashElement(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  // Restart the animation when the same element flashes twice in a row.
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), FLASH_MS);
}

function scrollToElement(el: Element): void {
  if (typeof (el as HTMLElement).scrollIntoView === 'function') {
    (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/**
 * Scroll the editor to a change and highlight it briefly. For a change with nothing left
 * in the document (a deletion) the block where the text was flashes instead, or the
 * change's deletion marker when it has one. Returns false when the change can't be located.
 */
export function revealChangeInEditor(
  editor: LexicalEditor | null,
  change: { id: string; richTextOldValue?: string; richTextNewValue?: string },
): boolean {
  if (!editor) return false;
  const root = editor.getRootElement();
  // A deletion marker of this change, if it has one, is the clearest thing to show.
  const marker = root?.querySelector(`.tracked-deletion-wrapper[data-change-id="${CSS.escape(change.id)}"]`) as HTMLElement | null;
  if (!change.richTextOldValue || !change.richTextNewValue) {
    if (!marker) return false;
    scrollToElement(marker);
    flashElement(marker, 'tracked-change-active');
    return true;
  }
  const location = locateChangeInEditor(editor, change.richTextOldValue, change.richTextNewValue);
  if (!location) {
    if (!marker) return false;
    scrollToElement(marker);
    flashElement(marker, 'tracked-change-active');
    return true;
  }

  const resolved = editor.getEditorState().read(() => {
    const block = $getRoot().getChildAtIndex(location.start.block);
    return {
      blockKey: block?.getKey() ?? null,
      start: $resolveUnitPoint(location.start),
      end: location.collapsed ? null : $resolveUnitPoint(location.end),
    };
  });
  const blockEl = resolved.blockKey ? editor.getElementByKey(resolved.blockKey) : null;

  if (location.collapsed || !resolved.start || !resolved.end) {
    const target = marker || blockEl;
    if (!target) return false;
    scrollToElement(target);
    flashElement(target, marker ? 'tracked-change-active' : ANCHOR_FLASH_CLASS);
    return true;
  }

  const range = document.createRange();
  if (!setBoundary(editor, range, resolved.start, 'start') || !setBoundary(editor, range, resolved.end, 'end')) {
    if (!blockEl) return false;
    scrollToElement(blockEl);
    flashElement(blockEl, ANCHOR_FLASH_CLASS);
    return true;
  }
  const startEl = editor.getElementByKey(resolved.start.key) || blockEl;
  if (startEl) scrollToElement(startEl);
  flashRange(range, startEl);
  return true;
}

/**
 * The change whose highlighted text is at (x, y) in the editor: a deletion marker under
 * the target, or an addition highlight range containing the point. Null when none.
 */
export function changeIdAtPoint(target: EventTarget | null, x: number, y: number): string | null {
  const el = target instanceof Element ? target : null;
  const marker = el?.closest('[data-change-id]');
  const markerId = marker?.getAttribute('data-change-id');
  if (markerId && !markerId.startsWith('__')) return markerId;
  if (!highlightsSupported()) return null;
  let found: string | null = null;
  (CSS as any).highlights.forEach((highlight: any, name: string) => {
    if (found || !name.startsWith(CHANGE_HIGHLIGHT_PREFIX)) return;
    const id = name.slice(CHANGE_HIGHLIGHT_PREFIX.length);
    if (id.startsWith('__')) return;
    for (const range of highlight as Iterable<Range>) {
      for (const rect of Array.from(range.getClientRects())) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          found = id;
          return;
        }
      }
    }
  });
  return found;
}
