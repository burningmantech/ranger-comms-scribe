import { originalDocument } from '../originalContent';

const lexical = (text: string) => JSON.stringify({
  root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text }] }] },
});

describe('originalDocument (the document as submitted)', () => {
  const accepted = lexical('Hello big world'); // what accept wrote into richTextContent
  const changes = [
    { field: 'content', status: 'approved', timestamp: new Date('2026-10-05T10:00:05Z'), richTextOldValue: lexical('Hello big') },
    { field: 'content', status: 'approved', timestamp: new Date('2026-10-05T10:00:00Z'), richTextOldValue: lexical('Hello') },
    { field: 'title', status: 'pending', timestamp: new Date('2026-10-05T09:00:00Z'), richTextOldValue: lexical('Old title') },
  ];

  it('reads the immutable field, not the rewritten richTextContent', () => {
    const original = lexical('As submitted');
    expect(originalDocument({ originalContent: original, richTextContent: accepted, content: 'Hello big world', changes })).toBe(original);
  });

  it('prefers originalRichTextContent when originalContent is plain text', () => {
    const rich = lexical('As submitted');
    expect(originalDocument({ originalContent: 'As submitted', originalRichTextContent: rich, richTextContent: accepted })).toBe(rich);
    expect(originalDocument({ originalContent: 'As submitted', richTextContent: accepted })).toBe('As submitted');
  });

  it('falls back to the earliest content change\'s richTextOldValue for older submissions', () => {
    expect(originalDocument({ richTextContent: accepted, content: 'Hello big world', changes })).toBe(lexical('Hello'));
  });

  it('accepts string timestamps and skips changes without Lexical before-values', () => {
    const raw = [
      { field: 'content', timestamp: '2026-10-05T08:00:00Z', richTextOldValue: 'plain' },
      { field: 'content', timestamp: '2026-10-05T10:00:00Z', richTextOldValue: lexical('Hello') },
    ];
    expect(originalDocument({ richTextContent: accepted, changes: raw })).toBe(lexical('Hello'));
  });

  it('uses the current value when there are no changes', () => {
    expect(originalDocument({ richTextContent: lexical('Untouched'), content: 'Untouched', changes: [] })).toBe(lexical('Untouched'));
    expect(originalDocument({ content: 'Plain only' })).toBe('Plain only');
    expect(originalDocument({})).toBe('');
  });
});
