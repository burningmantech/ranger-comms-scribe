import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LexicalEditor } from 'lexical';
import { textRects } from '../editor/utils/replaceText';
import { DateGroup, GroupStatus, groupSummary } from './dateGroups';
import './Dates.css';

interface DateBubblesProps {
  editor: LexicalEditor | null;
  /** The positioned element the marks are placed in (it contains the editor and scrolls with it). */
  container: HTMLElement | null;
  groups: DateGroup[];
  /** A bubble was clicked: show its date in "Dates in this request". */
  onSelect: (groupKey: string) => void;
  /** A mention to pulse (its row in the panel was clicked), by mention key. */
  flashKey?: string | null;
}

interface Line {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Mark {
  key: string;
  groupKey: string;
  status: GroupStatus;
  title: string;
  /** The date's text, one box per line it is on (for the underline). */
  lines: Line[];
  /** Where its bubble goes in the margin: the middle of its last line, after earlier bubbles on that line. */
  bubbleTop: number;
  bubbleSlot: number;
}

const BUBBLE_SPACING = 22;

/**
 * Each date in the body is underlined in the color of what "Dates in this request" says about it
 * (right, out of date, looks like a tracked date, not tracked), with a calendar bubble in the margin
 * beside its line that opens its row. An overlay, not part of the document: the editor, its tracked
 * changes and collaboration never see it.
 */
export const DateBubbles: React.FC<DateBubblesProps> = ({ editor, container, groups, onSelect, flashKey }) => {
  const [marks, setMarks] = useState<Mark[]>([]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Debounced with a timer, not requestAnimationFrame: that never runs in a background tab
  const measure = React.useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!editor || !container) return;
      const box = container.getBoundingClientRect();
      const next: Mark[] = [];
      const slots = new Map<number, number>();
      for (const group of groupsRef.current) {
        const title = groupSummary(group);
        for (const mention of group.mentions) {
          if (mention.source.field !== 'body') continue;
          const rects = textRects(editor, mention.found.text, mention.occurrence);
          if (!rects.length) continue;
          const lines = rects.map((rect) => ({
            left: rect.left - box.left,
            top: rect.top - box.top,
            width: rect.width,
            height: rect.height,
          }));
          const last = lines[lines.length - 1];
          const bubbleTop = Math.round(last.top + last.height / 2);
          const slot = slots.get(bubbleTop) || 0;
          slots.set(bubbleTop, slot + 1);
          next.push({ key: mention.key, groupKey: group.key, status: group.status, title, lines, bubbleTop, bubbleSlot: slot });
        }
      }
      setMarks(next);
    }, 50);
  }, [editor, container]);

  // Re-measure on every edit, layout change (images loading, the sidebar opening) and resize
  useEffect(() => {
    if (!editor || !container) return undefined;
    const unregister = editor.registerUpdateListener(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      unregister();
      observer.disconnect();
      window.removeEventListener('resize', measure);
      clearTimeout(timer.current);
    };
  }, [editor, container, measure]);

  useLayoutEffect(measure, [groups, measure]);

  useEffect(() => {
    if (!flashKey || !container) return;
    container.querySelector(`[data-mention-key="${CSS.escape(flashKey)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [flashKey, container]); // not on every re-measure: only when asked

  if (!marks.length || !container) return null;
  const gutter = container.clientWidth + 8;
  return (
    <div className="dt-bubbles">
      {marks.map((mark) => (
        <React.Fragment key={mark.key}>
          {mark.lines.map((line, i) => (
            <span
              key={i}
              className={`dt-underline dt-underline--${mark.status}${flashKey === mark.key ? ' dt-underline--flash' : ''}`}
              style={{ left: line.left, top: line.top, width: line.width, height: line.height }}
            />
          ))}
          <button
            type="button"
            data-mention-key={mark.key}
            className={`dt-bubble dt-bubble--${mark.status}${flashKey === mark.key ? ' dt-bubble--flash' : ''}`}
            style={{ left: gutter + mark.bubbleSlot * BUBBLE_SPACING, top: mark.bubbleTop }}
            title={mark.title}
            aria-label={mark.title}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(mark.groupKey)}
          >
            <i className="far fa-calendar-alt" aria-hidden="true" />
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};

export default DateBubbles;
