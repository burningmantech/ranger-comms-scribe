import { applyBlockReplacements, planRejectRestore } from '../rejectRestore';

// ---------------------------------------------------------------------------
// Fixtures: serialized Lexical JSON
// ---------------------------------------------------------------------------

type Inline = string | Record<string, unknown>;

const t = (text: string, format = 0) => ({ type: 'text', text, format, detail: 0, mode: 'normal', style: '', version: 1 });
const LB = { type: 'linebreak', version: 1 };
const inline = (children: Inline[]) => children.map((c) => (typeof c === 'string' ? t(c) : c));
const p = (...children: Inline[]) => ({
  type: 'paragraph', children: inline(children), direction: 'ltr', format: '', indent: 0, textFormat: 0, textStyle: '', version: 1,
});
const h = (tag: string, ...children: Inline[]) => ({
  type: 'heading', tag, children: inline(children), direction: 'ltr', format: '', indent: 0, version: 1,
});
const link = (url: string, ...children: Inline[]) => ({
  type: 'link', url, rel: null, target: null, title: null, children: inline(children), direction: 'ltr', format: '', indent: 0, version: 1,
});
const list = (...items: string[]) => ({
  type: 'list', listType: 'bullet', start: 1, tag: 'ul', direction: 'ltr', format: '', indent: 0, version: 1,
  children: items.map((text, i) => ({ type: 'listitem', value: i + 1, children: [t(text)], direction: 'ltr', format: '', indent: 0, version: 1 })),
});
const EMPTY = p();
const doc = (...blocks: unknown[]) => ({
  root: { type: 'root', children: blocks, direction: 'ltr', format: '', indent: 0, version: 1 },
});
type Doc = ReturnType<typeof doc>;

/** Comparable form: no computed properties, adjacent equal text nodes merged. */
function norm(nodes: any[]): any[] {
  const out: any[] = [];
  for (const n of nodes) {
    const { direction, textFormat, textStyle, version, detail, children, ...rest } = n;
    const node: any = { ...rest };
    if (Array.isArray(children)) node.children = norm(children);
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && node.type === 'text' &&
        prev.format === node.format && prev.style === node.style && prev.mode === node.mode) {
      prev.text += node.text;
      continue;
    }
    if (node.type === 'text' && node.text === '') continue;
    out.push(node);
  }
  return out;
}

const blockText = (b: any): string =>
  b.type === 'text' ? b.text : b.type === 'linebreak' ? '\n' : (b.children || []).map(blockText).join('');
const texts = (d: Doc) => d.root.children.map(blockText);

/** Reject the change before -> after on live; returns the new document, or the failure. */
function reject(before: Doc, after: Doc, live: Doc): Doc | { ok: false; reason: string } {
  const plan = planRejectRestore(before, after, live.root.children);
  if (!plan.ok) return plan;
  return doc(...applyBlockReplacements(live.root.children, plan.replacements));
}
function rejectOk(before: Doc, after: Doc, live: Doc): Doc {
  const result = reject(before, after, live);
  if ('ok' in result) throw new Error(`reject failed: ${result.reason}`);
  return result as Doc;
}
const expectSame = (a: Doc, b: Doc) => expect(norm(a.root.children)).toEqual(norm(b.root.children));

// ---------------------------------------------------------------------------
// The move from the bug report: cut a two-paragraph section, paste it after "$75."
// ---------------------------------------------------------------------------

const W = p('Welcome to the 2026 event. Please read everything below.');
const S1 = p('New for 2026: ', t('early arrival passes', 1), ' are available for build crews.');
const S2 = p('Passes are limited to one per camp and must be requested by June 1.');
const T = h('h2', 'Tickets');
const G = p('General admission is $75.', LB, 'When you arrive, check in at the gate with your ID.');
const Z = p('Thanks, and see you on the playa.');

const doc0 = doc(W, S1, S2, T, G, Z);

/** The cut: the two paragraphs removed whole (variant: an empty paragraph left behind). */
const doc1 = doc(W, T, G, Z);
const doc1Empty = doc(W, EMPTY, T, G, Z);

/** The paste right after "$75.": the first pasted paragraph joins "$75.", the last joins "When". */
const pasteMid = (before: unknown[]) => doc(
  ...before,
  p('General admission is $75.New for 2026: ', t('early arrival passes', 1), ' are available for build crews.'),
  p('Passes are limited to one per camp and must be requested by June 1.', LB, 'When you arrive, check in at the gate with your ID.'),
  Z,
);
/** The paste as whole paragraphs after the "$75." paragraph. */
const pasteBlocks = (before: unknown[]) => doc(...before, G, S1, S2, Z);

describe('move (cut a section, paste it elsewhere): reject both halves', () => {
  const shapes: Array<[string, Doc, Doc]> = [
    ['cut whole paragraphs, paste mid-paragraph', doc1, pasteMid([W, T])],
    ['cut leaves an empty paragraph, paste mid-paragraph', doc1Empty, pasteMid([W, EMPTY, T])],
    ['cut whole paragraphs, paste as paragraphs', doc1, pasteBlocks([W, T])],
    ['cut leaves an empty paragraph, paste as paragraphs', doc1Empty, pasteBlocks([W, EMPTY, T])],
  ];

  for (const [name, afterCut, afterPaste] of shapes) {
    describe(name, () => {
      const change1 = { before: doc0, after: afterCut }; // the deletion
      const change2 = { before: afterCut, after: afterPaste }; // the insertion

      it('reject the deletion first, then the insertion', () => {
        const mid = rejectOk(change1.before, change1.after, afterPaste);
        // The section is back at its old place and still at the new one.
        expect(texts(mid).filter((x) => x.includes('Passes are limited')).length).toBe(2);
        expect(texts(mid).slice(0, 3)).toEqual(texts(doc0).slice(0, 3));
        const end = rejectOk(change2.before, change2.after, mid);
        expectSame(end, doc0);
      });

      it('reject the insertion first, then the deletion', () => {
        const mid = rejectOk(change2.before, change2.after, afterPaste);
        expectSame(mid, afterCut);
        const end = rejectOk(change1.before, change1.after, mid);
        expectSame(end, doc0);
      });
    });
  }

  it('only replaces the blocks around each hunk', () => {
    const live = pasteMid([W, T]);
    const plan = planRejectRestore(doc1, live, live.root.children);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.replacements).toHaveLength(1);
    expect(plan.replacements[0].start).toBe(2);
    expect(plan.replacements[0].deleteCount).toBe(2);
    expect(norm(plan.replacements[0].nodes)).toEqual(norm([G]));
  });
});

// ---------------------------------------------------------------------------
// Single changes
// ---------------------------------------------------------------------------

describe('reject a multi-paragraph paste', () => {
  const A = p('First paragraph stays.');
  const B = p('Last paragraph stays too.');
  const before = doc(A, B);
  const after = doc(A, p('Pasted one.'), p('Pasted ', link('https://example.org', 'two'), '.'), list('alpha', 'beta'), p('Pasted four.'), B);

  it('removes all pasted blocks', () => {
    expectSame(rejectOk(before, after, after), before);
  });

  it('removes a paste that began and ended mid-paragraph', () => {
    const b2 = doc(p('Start here and finish there.'));
    const a2 = doc(p('Start here PASTE ONE'), p('PASTE TWO'), p('PASTE THREE and finish there.'));
    expectSame(rejectOk(b2, a2, a2), b2);
  });
});

describe('reject a deletion in the middle of a paragraph', () => {
  const before = doc(p('Intro.'), p('The quick ', t('brown', 1), ' fox jumps over the lazy dog.'), p('Outro.'));
  const after = doc(p('Intro.'), p('The quick fox jumps over the lazy dog.'), p('Outro.'));

  it('restores the text with its formatting', () => {
    const result = rejectOk(before, after, after);
    expectSame(result, before);
    expect((result.root.children[1] as any).children[1]).toMatchObject({ text: 'brown', format: 1 });
  });
});

describe('reject after someone else edited an unrelated part of the document', () => {
  const before = doc(p('Alpha paragraph.'), p('Beta paragraph with a sentence.'), p('Gamma paragraph.'));
  const after = doc(p('Alpha paragraph.'), p('Beta paragraph with a longer sentence.'), p('Gamma paragraph.'));
  const live = doc(
    p('Alpha paragraph, edited by Carol.'),
    p('Beta paragraph with a longer sentence.'),
    p('Gamma paragraph.'),
    p('A paragraph Carol added.'),
  );

  it('reverts only the change and keeps the other edits', () => {
    expectSame(rejectOk(before, after, live), doc(
      p('Alpha paragraph, edited by Carol.'),
      p('Beta paragraph with a sentence.'),
      p('Gamma paragraph.'),
      p('A paragraph Carol added.'),
    ));
  });

  it('keeps an edit made in the same paragraph, outside the change', () => {
    const sameParagraph = doc(p('Alpha paragraph.'), p('Carol: Beta paragraph with a longer sentence. Done.'), p('Gamma paragraph.'));
    expectSame(rejectOk(before, after, sameParagraph), doc(
      p('Alpha paragraph.'), p('Carol: Beta paragraph with a sentence. Done.'), p('Gamma paragraph.'),
    ));
  });

  it('keeps the other paragraphs untouched (only the changed block is replaced)', () => {
    const plan = planRejectRestore(before, after, live.root.children);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.replacements).toEqual([expect.objectContaining({ start: 1, deleteCount: 1 })]);
  });
});

describe('reject after someone edited the text around the change (fuzzy)', () => {
  it('restores a deletion when a word next to it changed', () => {
    const before = doc(p('The quick brown fox jumps over the lazy dog every morning.'));
    const after = doc(p('The quick fox jumps over the lazy dog every morning.'));
    const live = doc(p('The quick fox leaps over the lazy dog every morning.'));
    expectSame(rejectOk(before, after, live), doc(p('The quick brown fox leaps over the lazy dog every morning.')));
  });

  it('removes a pasted paragraph that someone corrected a typo in', () => {
    const before = doc(p('Keep this one.'), p('And this one.'));
    const after = doc(p('Keep this one.'), p('Pasted paragrahp about the burn schedule and the gate hours.'), p('And this one.'));
    const live = doc(p('Keep this one.'), p('Pasted paragraph about the burn schedule and the gate hours.'), p('And this one.'));
    expectSame(rejectOk(before, after, live), before);
  });

  it('removes an insertion when the paragraph around it was edited', () => {
    const before = doc(p('Gate opens at noon on Sunday for everyone.'));
    const after = doc(p('Gate opens at noon (Pacific time) on Sunday for everyone.'));
    const live = doc(p('The gate opens at noon (Pacific time) on Sunday for all participants.'));
    expectSame(rejectOk(before, after, live), doc(p('The gate opens at noon on Sunday for all participants.')));
  });
});

describe('cannot locate the change', () => {
  it('fails when the inserted text was rewritten', () => {
    const before = doc(p('Keep this one.'), p('And this one.'));
    const after = doc(p('Keep this one.'), p('A pasted paragraph about the burn schedule.'), p('And this one.'));
    const rewritten = doc(p('Keep this one.'), p('Something else entirely, written by Carol.'), p('And this one.'));
    expect(reject(before, after, rewritten)).toMatchObject({ ok: false });
  });

  it('fails when the inserted text was moved elsewhere', () => {
    const before = doc(p('Keep this one.'), p('And this one.'), p('Third paragraph here.'), p('Fourth paragraph here.'));
    const after = doc(p('Keep this one.'), p('A pasted paragraph about the burn schedule.'), p('And this one.'), p('Third paragraph here.'), p('Fourth paragraph here.'));
    const moved = doc(p('Keep this one.'), p('And this one.'), p('Third paragraph here.'), p('A pasted paragraph about the burn schedule.'), p('Fourth paragraph here.'));
    expect(reject(before, after, moved)).toMatchObject({ ok: false });
  });

  it('succeeds without changes when the inserted text is already gone', () => {
    const before = doc(p('Keep this one.'), p('And this one.'));
    const after = doc(p('Keep this one.'), p('A pasted paragraph about the burn schedule.'), p('And this one.'));
    const removed = doc(p('Keep this one.'), p('And this one.'));
    expect(planRejectRestore(before, after, removed.root.children)).toEqual({ ok: true, replacements: [] });
  });

  it('fails when the text around a deletion was rewritten', () => {
    const before = doc(p('Bring water, shade and a bike.'));
    const after = doc(p('Bring water and a bike.'));
    const live = doc(p('Pack sunscreen, goggles, a dust mask and lights.'));
    expect(reject(before, after, live)).toMatchObject({ ok: false });
  });

  it('fails without rich text', () => {
    expect(planRejectRestore('', '{"root":{"children":[]}}', [])).toMatchObject({ ok: false });
  });
});

describe('other change shapes', () => {
  it('reverts a bold format change', () => {
    const before = doc(p('Make this word bold please.'));
    const after = doc(p('Make this ', t('word', 1), ' bold please.'));
    expectSame(rejectOk(before, after, after), before);
  });

  it('reverts a block type change', () => {
    const before = doc(p('Intro.'), p('Section title'), p('Body.'));
    const after = doc(p('Intro.'), h('h2', 'Section title'), p('Body.'));
    expectSame(rejectOk(before, after, after), before);
  });

  it('reverts a change inside a list (the list is one unit)', () => {
    const before = doc(p('Bring:'), list('water', 'shade'));
    const after = doc(p('Bring:'), list('water', 'shade', 'a bike'));
    expectSame(rejectOk(before, after, after), before);
  });

  it('does not restore deleted text twice when it is already back', () => {
    const before = doc(p('Alpha.'), p('Restored paragraph that was deleted.'), p('Omega.'));
    const after = doc(p('Alpha.'), p('Omega.'));
    const live = doc(p('Alpha.'), p('Restored paragraph that was deleted.'), p('Omega.'));
    expectSame(rejectOk(before, after, live), before);
  });

  it('is a no-op when the change made no difference', () => {
    const d = doc(p('Same.'));
    const plan = planRejectRestore(d, d, d.root.children);
    expect(plan).toEqual({ ok: true, replacements: [] });
  });

  it('never restores a deletion marker from the old content', () => {
    const marker = { type: 'deleted-text', changeId: 'other', deletedText: 'gone', authorId: 'u2', isBlockLevel: false, version: 1 };
    const before = doc(p('Keep ', marker, 'this.'));
    const after = doc(p('Keep '));
    const result = rejectOk(before, after, after);
    expect(JSON.stringify(result)).not.toContain('deleted-text');
    expect(texts(result)).toEqual(['Keep this.']);
  });

  it("keeps another change's deletion marker that is in the live document", () => {
    const marker = { type: 'deleted-text', changeId: 'other', deletedText: 'gone', authorId: 'u2', isBlockLevel: false, version: 1 };
    const before = doc(p('Alpha beta gamma delta.'));
    const after = doc(p('Alpha beta NEW gamma delta.'));
    const live = doc(p('Alpha ', marker, 'beta NEW gamma delta.'));
    expectSame(rejectOk(before, after, live), doc(p('Alpha ', marker, 'beta gamma delta.')));
  });
});

describe('long documents', () => {
  it('handles a move in a 400-paragraph document quickly, in both orders', () => {
    const line = (i: number) => `Paragraph ${i}: the quick brown fox jumps over the lazy dog, line ${i} of the document.`;
    const all = Array.from({ length: 400 }, (_, i) => p(line(i)));
    const first = 'Moved section first paragraph, a fairly long one with plenty of words in it.';
    const second = 'Moved section second paragraph.';
    const d0 = doc(...all.slice(0, 50), p(first), p(second), ...all.slice(50));
    const d1 = doc(...all);
    const d2 = doc(...all.slice(0, 350), p(line(350) + first), p(second), ...all.slice(351));
    const started = Date.now();
    expectSame(rejectOk(d1, d2, rejectOk(d0, d1, d2)), d0);
    expectSame(rejectOk(d0, d1, rejectOk(d1, d2, d2)), d0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
