/**
 * Where a change's added text is highlighted (locateChangeText, collaborative mode). The patch
 * is snapped to whole words: a character diff would match a replacement's letters to the old
 * word's ("CF" over "CloudFront" keeps C and F) and leave nothing to highlight.
 */
import { locateChangeText } from '../rejectRestore';

const t = (text: string, format = 0) => ({ type: 'text', text, format, style: '', mode: 'normal', detail: 0, version: 1 });
const m = (deletedText: string) => ({
  type: 'deleted-text', version: 1, changeId: 'c1', deletedText, authorName: 'A', authorColor: '#f00', isBlockLevel: false,
});
const p = (...children: any[]) => ({ type: 'paragraph', children, direction: 'ltr', format: '', indent: 0, version: 1 });
const doc = (...blocks: any[]) => JSON.stringify({ root: { type: 'root', children: blocks, direction: 'ltr', format: '', indent: 0, version: 1 } });
const plain = (n: any): string => (n.type === 'deleted-text' ? '' : (n.text ?? '') + (n.children ?? []).map(plain).join(''));

/** The live text of each highlighted range, or null when the change can't be located. */
function highlighted(before: any[], after: any[], live: any[] = after): string[] | null {
  const ranges = locateChangeText(doc(...before), doc(...after), live);
  const text = live.map(plain).join('');
  return ranges && ranges.map((r) => text.slice(r.start, r.end));
}

const ORIGINAL = 'the dev stack that owns CloudFront. cdk diff showed that header as the only change.';

describe('locateChangeText: the added text of a replacement', () => {
  it('a word typed over another, with or without the deletion marker', () => {
    const replaced = 'the dev stack that owns CF. cdk diff showed that header as the only change.';
    expect(highlighted([p(t(ORIGINAL))], [p(t(replaced))])).toEqual(['CF']);
    expect(highlighted([p(t(ORIGINAL))], [p(t('the dev stack that owns '), m('CloudFront'), t('CF. cdk diff showed that header as the only change.'))])).toEqual(['CF']);
    expect(highlighted([p(t('that header as'))], [p(t('that footer as'))])).toEqual(['footer']);
    expect(highlighted(
      [p(t('owns '), m('CloudFront'), t('CF. that header as'))],
      [p(t('owns '), m('CloudFront'), t('CF. that '), m('header'), t('footer as'))],
    )).toEqual(['footer']);
  });

  it('a later change elsewhere leaves an earlier one located (both against the final document)', () => {
    const afterFirst = [p(t('owns '), m('CloudFront'), t('CF. that header as'))];
    const final = [p(t('owns '), m('CloudFront'), t('CF. that '), m('header'), t('footer as'))];
    expect(highlighted([p(t('owns CloudFront. that header as'))], afterFirst, final)).toEqual(['CF']);
  });

  it('part of a word typed over, a typo fixed, a shortened word', () => {
    expect(highlighted([p(t('owns CloudFront.'))], [p(t('owns Cloud'), m('Front'), t('Watch.'))])).toEqual(['Watch']);
    expect(highlighted([p(t('see teh doc'))], [p(t('see '), m('teh'), t('the doc'))])).toEqual(['the']);
    expect(highlighted([p(t('in January now'))], [p(t('in '), m('January'), t('Jan now'))])).toEqual(['Jan']);
  });

  it('pure insertions stay exact', () => {
    expect(highlighted([p(t('my color.'))], [p(t('my colour.'))])).toEqual(['u']);
    expect(highlighted([p(t('a b.'))], [p(t('a new b.'))])).toEqual(['new ']);
  });

  it('pure deletions (Backspace, letter by letter or within a word) add nothing to highlight', () => {
    expect(highlighted([p(t('owns CloudFront.'))], [p(t('owns C'), m('loud'), t('F'), m('ront'), t('.'))])).toEqual([]);
    expect(highlighted([p(t('my colour.'))], [p(t('my colo'), m('u'), t('r.'))])).toEqual([]);
    expect(highlighted([p(t('my colour.'))], [p(t('my color.'))])).toEqual([]);
  });
});
