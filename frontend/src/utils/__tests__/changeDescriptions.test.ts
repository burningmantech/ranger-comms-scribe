import { describeChange, normalizeText, summarizeDescription, textDiff } from '../changeDescriptions';

const t = (text: string, format = 0) => ({ type: 'text', text, format, detail: 0, mode: 'normal', style: '', version: 1 });
const p = (...children: any[]) => ({ type: 'paragraph', children, direction: 'ltr', format: '', indent: 0, version: 1 });
const h = (tag: string, text: string) => ({ type: 'heading', tag, children: [t(text)], direction: 'ltr', format: '', indent: 0, version: 1 });
const doc = (...blocks: any[]) => JSON.stringify({ root: { type: 'root', children: blocks, direction: 'ltr', format: '', indent: 0, version: 1 } });
const marker = (deletedText: string) => ({ type: 'deleted-text', changeId: '__pending_deletion__', deletedText, authorId: 'u1', version: 1 });

/** A change record as the app stores it: whole documents before and after. */
const change = (before: string, after: string) => ({ field: 'content', richTextOldValue: before, richTextNewValue: after, oldValue: '', newValue: '' });

describe('textDiff', () => {
  it('finds an insertion in the middle of a long text cheaply (prefix and suffix dropped)', () => {
    const long = 'word '.repeat(5000);
    expect(textDiff(long + 'end', long + 'brand new end')).toEqual({ deleted: [], inserted: ['brand new '] });
  });

  it('does not split words at the diff boundary', () => {
    expect(textDiff('the cat sat', 'the cut sat')).toEqual({ deleted: ['cat'], inserted: ['cut'] });
  });

  it('keeps a multi-word replacement in one run', () => {
    expect(textDiff('the quick brown fox', 'a slow brown fox')).toEqual({ deleted: ['the quick'], inserted: ['a slow'] });
  });
});

describe('describeChange (plain language)', () => {
  it('Added: the inserted text', () => {
    expect(describeChange(change(doc(p(t('Hello world.'))), doc(p(t('Hello big world.')))))).toEqual({ kind: 'added', text: 'big' });
  });

  it('Deleted: the removed text (a deletion marker in the new document counts as removed)', () => {
    const d = describeChange(change(doc(p(t('Keep this. Drop this. Keep that.'))), doc(p(t('Keep this. '), marker('Drop this. '), t('Keep that.')))));
    expect(d).toEqual({ kind: 'deleted', text: 'Drop this.' });
  });

  it("Replaced 'x' with 'y'", () => {
    const d = describeChange(change(doc(p(t('Tickets cost $75.'))), doc(p(t('Tickets cost $90.')))));
    expect(d).toEqual({ kind: 'replaced', text: '', from: '$75.', to: '$90.' });
    expect(summarizeDescription(d)).toBe('Replaced "$75." with "$90."');
  });

  it('Moved: a paragraph cut and pasted elsewhere in one change', () => {
    const before = doc(p(t('Alpha paragraph.')), p(t('Beta paragraph here.')), p(t('Gamma paragraph.')));
    const after = doc(p(t('Alpha paragraph.')), p(t('Gamma paragraph.')), p(t('Beta paragraph here.')));
    const d = describeChange(change(before, after));
    expect(d.kind).toBe('moved');
    expect(['Beta paragraph here.', 'Gamma paragraph.']).toContain(d.text);
  });

  it('Formatted: bold and heading changes', () => {
    const bold = describeChange(change(doc(p(t('Make this bold.'))), doc(p(t('Make '), t('this', 1), t(' bold.')))));
    expect(bold).toEqual({ kind: 'formatted', text: '', details: ['Made "this" bold'] });
    const heading = describeChange(change(doc(p(t('Tickets'))), doc(h('h2', 'Tickets'))));
    expect(heading.kind).toBe('formatted');
    expect(heading.details).toEqual(['Changed "Tickets" from Paragraph to Heading 2']);
  });

  it('a line break added with Enter', () => {
    const d = describeChange(change(doc(p(t('One. Two.'))), doc(p(t('One.')), p(t('Two.')))));
    expect(d.kind).toBe('added');
    expect(d.text).toBe('');
    expect(summarizeDescription(d)).toMatch(/line break|space/);
  });

  it('works from plain text when there is no rich text', () => {
    expect(describeChange({ field: 'content', oldValue: 'Hello world', newValue: 'Hello there world' })).toEqual({ kind: 'added', text: 'there' });
  });

  it('describes a form field change from its whole values', () => {
    expect(describeChange({ field: 'title', oldValue: 'Old subject', newValue: 'New subject' }))
      .toEqual({ kind: 'replaced', text: '', from: 'Old subject', to: 'New subject' });
    expect(describeChange({ field: 'title', oldValue: '', newValue: 'A subject' })).toEqual({ kind: 'added', text: 'A subject' });
  });

  it('normalizeText collapses whitespace and line breaks', () => {
    expect(normalizeText('  a\n\nb   c ')).toBe('a b c');
  });
});
