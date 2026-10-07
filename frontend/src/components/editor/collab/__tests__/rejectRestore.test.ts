import { applyBlockReplacements, locateChange, planReapply, planRejectRestore } from '../rejectRestore';

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
// A move's insertion when its deletion is already rejected (movePartner)
// ---------------------------------------------------------------------------

describe('move: the insertion with its deletion rejected (movePartner)', () => {
  // The dev-site document: a bold heading with a line break and its list, cut (an empty
  // paragraph is left) and pasted over the empty paragraph before "General Info:".
  const R = p('Rangers Ticketing Team');
  const C = p('The Clubhouse Ticketing is now open. Read everything below.');
  const NEW = p(t('New for 2026:', 1), ' ', LB);
  const L2 = list('Special Price Tickets will cost $250 plus fees.', 'All Setup Access Passes are sent in one email.');
  const K = p('Key Things to Know for 2026:');
  const L1 = list('Only claim a Vehicle Pass if you need one.', 'Make sure you pay for both in one cart.');
  const GI = p('General Info:');
  const LAST = p('Last paragraph text. Typed by A.');
  const original = doc(R, C, NEW, L2, K, L1, EMPTY, GI, LAST);
  const cut = doc(R, C, EMPTY, K, L1, EMPTY, GI, LAST);
  const pasted = doc(R, C, EMPTY, K, L1, NEW, L2, GI, LAST);
  const deletion = { before: original, after: cut };
  const insertion = { before: cut, after: pasted };

  const plan = (live: Doc, partner?: { before: Doc; after: Doc }) =>
    planRejectRestore(insertion.before, insertion.after, live.root.children, partner ? { movePartner: partner } : {});

  it('without the partner, the insertion is matched to the restored copy (why the option exists)', () => {
    // The deletion's restored text looks like the insertion's: the reject would remove it.
    const result = plan(original);
    expect(result.ok && result.replacements.length > 0).toBe(true);
  });

  it('its text gone and the deletion rejected: rejecting it changes nothing', () => {
    expect(plan(original, deletion)).toEqual({ ok: true, replacements: [] });
  });

  it('the deletion rejected first, then the insertion: the original document', () => {
    const mid = rejectOk(deletion.before, deletion.after, pasted);
    const result = plan(mid, deletion);
    if (!result.ok) throw new Error(result.reason);
    expectSame(doc(...applyBlockReplacements(mid.root.children, result.replacements)), original);
  });

  it('the deletion pending (the move intact): the pasted copy is removed as usual', () => {
    const result = plan(pasted, deletion);
    if (!result.ok) throw new Error(result.reason);
    expectSame(doc(...applyBlockReplacements(pasted.root.children, result.replacements)), cut);
  });

  it('the partner is ignored when it is not where it was cut (no restored text to set aside)', () => {
    // A doc with neither copy: the insertion is already gone, the deletion not restored.
    expect(plan(cut, deletion)).toEqual({ ok: true, replacements: [] });
  });

  // The bug-report shapes: the same, with the partner given.
  const shapes: Array<[string, Doc, Doc]> = [
    ['cut whole paragraphs, paste mid-paragraph', doc1, pasteMid([W, T])],
    ['cut leaves an empty paragraph, paste mid-paragraph', doc1Empty, pasteMid([W, EMPTY, T])],
    ['cut whole paragraphs, paste as paragraphs', doc1, pasteBlocks([W, T])],
    ['cut leaves an empty paragraph, paste as paragraphs', doc1Empty, pasteBlocks([W, EMPTY, T])],
  ];
  for (const [name, afterCut, afterPaste] of shapes) {
    it(`${name}: deletion then insertion with the partner gives the original; the insertion again changes nothing`, () => {
      const del = { before: doc0, after: afterCut };
      const mid = rejectOk(del.before, del.after, afterPaste);
      const r = planRejectRestore(afterCut, afterPaste, mid.root.children, { movePartner: del });
      if (!r.ok) throw new Error(r.reason);
      const end = doc(...applyBlockReplacements(mid.root.children, r.replacements));
      expectSame(end, doc0);
      expect(planRejectRestore(afterCut, afterPaste, end.root.children, { movePartner: del })).toEqual({ ok: true, replacements: [] });
    });
  }
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

// ---------------------------------------------------------------------------
// Undo of a reject: re-apply (planReapply)
// ---------------------------------------------------------------------------

function reapply(changes: Array<{ before: Doc; after: Doc; id?: string }>, live: Doc, keepMarkers = false): Doc {
  const plan = planReapply(changes, live.root.children, { keepMarkers });
  if (!plan.ok) throw new Error(`re-apply failed: ${plan.reason}`);
  return doc(...applyBlockReplacements(live.root.children, plan.replacements));
}

describe('undo of a reject: re-apply the change', () => {
  const shapes: Array<[string, Doc, Doc]> = [
    ['cut whole paragraphs, paste mid-paragraph', doc1, pasteMid([W, T])],
    ['cut leaves an empty paragraph, paste mid-paragraph', doc1Empty, pasteMid([W, EMPTY, T])],
    ['cut whole paragraphs, paste as paragraphs', doc1, pasteBlocks([W, T])],
  ];
  for (const [name, afterCut, afterPaste] of shapes) {
    it(`${name}: rejecting the move and undoing it gives the moved document back`, () => {
      const change1 = { id: 'c1', before: doc0, after: afterCut };
      const change2 = { id: 'c2', before: afterCut, after: afterPaste };
      // Reject the deletion first, then the insertion (the order the Moved card uses)
      const restored = rejectOk(change2.before, change2.after, rejectOk(change1.before, change1.after, afterPaste));
      expectSame(restored, doc0);
      // Undo both, oldest first
      expectSame(reapply([change1, change2], restored), afterPaste);
    });
  }

  it('re-applies one rejected change and leaves later edits elsewhere alone', () => {
    const before = doc(p('Alpha beta gamma.'), p('Second line.'));
    const after = doc(p('Alpha beta NEW gamma.'), p('Second line.'));
    const rejected = rejectOk(before, after, after);
    expectSame(rejected, before);
    const edited = doc(p('Alpha beta gamma.'), p('Second line, edited by someone.'));
    expectSame(reapply([{ before, after }], edited), doc(p('Alpha beta NEW gamma.'), p('Second line, edited by someone.')));
  });

  it('re-applies a deletion', () => {
    const before = doc(p('Keep this. Remove this sentence. Keep that.'));
    const after = doc(p('Keep this. Keep that.'));
    expectSame(reapply([{ before, after }], before), after);
  });

  it('is a no-op for a change whose text is already there', () => {
    const before = doc(p('Alpha beta gamma.'));
    const after = doc(p('Alpha beta NEW gamma.'));
    const plan = planReapply([{ before, after }], after.root.children);
    expect(plan).toEqual({ ok: true, replacements: [] });
  });

  it("fails (nothing to change) when the change's region was rewritten", () => {
    const before = doc(p('The quick brown fox jumps over the lazy dog.'));
    const after = doc(p('The quick brown fox leaps gracefully over the lazy dog.'));
    const rewritten = doc(p('Completely different text now.'));
    expect(planReapply([{ before, after }], rewritten.root.children)).toMatchObject({ ok: false });
  });

  it('is all or nothing across several changes', () => {
    const b1 = doc(p('One two three.'), p('Four five six.'));
    const a1 = doc(p('One two NEW three.'), p('Four five six.'));
    const unrelated = { before: doc(p('Nothing like this.')), after: doc(p('Nothing like this at all.')) };
    expect(planReapply([{ before: b1, after: a1 }, unrelated], b1.root.children)).toMatchObject({ ok: false });
  });

  it("with keepMarkers, puts the change's own deletion marker back, with its id", () => {
    const marker = { type: 'deleted-text', changeId: '__pending_deletion__', deletedText: 'old ', authorId: 'u1', isBlockLevel: false, version: 1 };
    const before = doc(p('Keep old text.'));
    const after = doc(p('Keep ', marker, 'text.'));
    const rejected = rejectOk(before, after, after);
    expectSame(rejected, before);
    const result = reapply([{ id: 'c9', before, after }], rejected, true);
    expectSame(result, doc(p('Keep ', { ...marker, changeId: 'c9' }, 'text.')));
    // Without it, the marker isn't restored (legacy mode adds its own)
    expectSame(reapply([{ before, after }], rejected), doc(p('Keep text.')));
  });
});

// ---------------------------------------------------------------------------
// Locating a change in the live document (for scrolling to it and ordering cards)
// ---------------------------------------------------------------------------

describe('locateChange', () => {
  it('finds an insertion: block and offsets of the added text', () => {
    const before = doc(p('First.'), p('Alpha beta gamma.'));
    const after = doc(p('First.'), p('Alpha beta NEW gamma.'));
    const loc = locateChange(before, after, after.root.children)!;
    expect(loc.collapsed).toBe(false);
    expect(loc.start).toEqual({ block: 1, offset: 'Alpha beta '.length });
    expect(loc.end).toEqual({ block: 1, offset: 'Alpha beta NEW '.length });
  });

  it('finds a deletion as a collapsed point where the text was', () => {
    const before = doc(p('Keep this. Remove this. Keep that.'));
    const after = doc(p('Keep this. Keep that.'));
    const loc = locateChange(before, after, after.root.children)!;
    expect(loc.collapsed).toBe(true);
    expect(loc.start).toEqual({ block: 0, offset: 'Keep this. '.length });
  });

  it('finds the change after other edits moved it down the document', () => {
    const before = doc(p('Alpha beta gamma.'));
    const after = doc(p('Alpha beta NEW gamma.'));
    const live = doc(p('An intro paragraph someone added.'), p('Alpha beta NEW gamma.'));
    const loc = locateChange(before, after, live.root.children)!;
    expect(loc.start.block).toBe(1);
  });

  it('orders changes by document position', () => {
    const live = doc(p('One two three.'), p('Four five six.'), p('Seven eight nine.'));
    const early = locateChange(doc(p('One three.'), p('Four five six.'), p('Seven eight nine.')), live, live.root.children)!;
    const late = locateChange(doc(p('One two three.'), p('Four five six.'), p('Seven nine.')), live, live.root.children)!;
    expect(early.order).toBeLessThan(late.order);
  });

  it('returns null for a change that is no longer in the document, or without rich text', () => {
    const before = doc(p('The quick brown fox jumps over the lazy dog.'));
    const after = doc(p('The quick brown fox leaps gracefully over the lazy dog.'));
    expect(locateChange(before, after, doc(p('Completely different text now.')).root.children)).toBeNull();
    expect(locateChange('', '', [])).toBeNull();
  });

  it('locates both halves of a move (the deletion where the text was, the insertion where it is)', () => {
    const live = pasteMid([W, T]);
    const del = locateChange(doc0, doc1, live.root.children)!;
    const ins = locateChange(doc1, live, live.root.children)!;
    expect(del.collapsed).toBe(true);
    expect(del.start.block).toBe(1); // where "New for 2026" was: before "Tickets"
    expect(ins.collapsed).toBe(false);
    expect(ins.start).toEqual({ block: 2, offset: 'General admission is $75.'.length });
    expect(del.order).toBeLessThan(ins.order);
  });
});
