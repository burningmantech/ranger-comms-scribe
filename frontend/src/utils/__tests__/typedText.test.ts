import { isTypedRange } from '../typedText';
import { buildResolveHints, pairBlocks } from '../resolveHints';

describe('isTypedRange', () => {
  const before = ['Intro.', '', 'Only claim what you need.Make sure you pay.', 'General Info:'];

  it('typed characters in a block are typed; saved ones are not', () => {
    const current = ['Intro.', '', 'Only claim what you need.Make sure you pay.\\\\', 'General Info:'];
    expect(isTypedRange(before, current, 2, 43, 44)).toBe(true);
    expect(isTypedRange(before, current, 2, 42, 43)).toBe(false); // the saved "."
    expect(isTypedRange(before, current, 2, 42, 44)).toBe(false); // partly saved
  });

  it('two typed places in one block: the saved text between them is not typed', () => {
    const current = ['Intro.', '', 'XOnly claim what you need.Make sure you pay.Y', 'General Info:'];
    expect(isTypedRange(before, current, 2, 0, 1)).toBe(true);
    expect(isTypedRange(before, current, 2, 44, 45)).toBe(true);
    expect(isTypedRange(before, current, 2, 10, 11)).toBe(false);
  });

  it('a block inserted above does not shift the comparison', () => {
    const current = ['Intro.', 'A new paragraph', '', 'Only claim what you need.Make sure you pay.', 'General Info:'];
    expect(isTypedRange(before, current, 1, 0, 5)).toBe(true); // in the new block
    expect(isTypedRange(before, current, 3, 3, 4)).toBe(false); // saved text, shifted block
  });

  it('a split block: the typed text after the split is typed, the moved saved text is not', () => {
    const current = ['Intro.', '', 'Only claim what you need.', 'NEW Make sure you pay.', 'General Info:'];
    expect(isTypedRange(before, current, 3, 0, 4)).toBe(true);
    expect(isTypedRange(before, current, 3, 4, 8)).toBe(false);
  });

  it('an unchanged block, or an out-of-range request, is never typed', () => {
    expect(isTypedRange(before, before, 0, 0, 1)).toBe(false);
    expect(isTypedRange(before, before, 9, 0, 1)).toBe(false);
    expect(isTypedRange(before, ['Intro.!', '', before[2], before[3]], 0, 6, 8)).toBe(false);
  });
});

describe('pairBlocks / legacy format hints', () => {
  it('pairs equal blocks and same-size edited runs; inserted or removed blocks pair with nothing', () => {
    expect(pairBlocks(['a', 'b', 'c'], ['a', 'c'])).toEqual([[0, 0], [2, 1]]);
    expect(pairBlocks(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(pairBlocks(['a', 'c'], ['a', 'x', 'y', 'c'])).toEqual([[0, 0], [1, 3]]);
  });

  const doc = (blocks: any[]) => JSON.stringify({ root: { children: blocks, type: 'root' } });
  const p = (text: string) => ({ type: 'paragraph', children: text ? [{ type: 'text', text, format: 0 }] : [] });
  const h = (text: string) => ({ type: 'heading', tag: 'h2', children: [{ type: 'text', text, format: 0 }] });
  const list = (...items: string[]) => ({ type: 'list', tag: 'ul', children: items.map((t) => ({ type: 'listitem', children: [{ type: 'text', text: t, format: 0 }] })) });

  it('a removed paragraph and list give no block changes for the blocks below them', () => {
    const before = doc([p('Intro'), p('New for 2026:'), list('One', 'Two'), p('Key Things'), list('Three'), p('')]);
    const after = doc([p('Intro'), p('Key Things'), list('Three'), p('')]);
    expect(buildResolveHints({ richTextOldValue: before, richTextNewValue: after }).formatChanges).toEqual([]);
  });

  it('still finds a block type change in place', () => {
    const before = doc([p('Intro'), p('Tickets'), p('Text')]);
    const after = doc([p('Intro'), h('Tickets'), p('Text')]);
    expect(buildResolveHints({ richTextOldValue: before, richTextNewValue: after }).formatChanges).toEqual([
      expect.objectContaining({ type: 'block', text: 'Tickets', fromType: 'paragraph', toType: 'heading', blockIndex: 1 }),
    ]);
  });

  it('computes no format changes in collaborative mode', () => {
    const before = doc([p('Intro'), p('Tickets')]);
    const after = doc([p('Intro'), h('Tickets')]);
    expect(buildResolveHints({ richTextOldValue: before, richTextNewValue: after }, { collab: true }).formatChanges).toEqual([]);
  });
});
