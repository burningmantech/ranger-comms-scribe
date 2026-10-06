import type { Comment } from '../../types/content';
import { mergeLocalChanges } from '../changeStatus';
import {
  applyStatusOverrides,
  buildCommentThreads,
  buildHistory,
  buildOpenItems,
  countOpenEdits,
  findMovePartner,
  orderByPosition,
  pairMoves,
  pendingOnly,
  ReviewChangeLike,
} from '../reviewItems';

const at = (s: number) => new Date(Date.UTC(2026, 9, 5, 10, 0, s));

/** A change described by its plain texts (no rich text: describeChange diffs these). */
function change(id: string, oldValue: string, newValue: string, extra: Partial<ReviewChangeLike> = {}): ReviewChangeLike {
  return { id, field: 'content', oldValue, newValue, changedBy: 'alice@x', timestamp: at(Number(id.replace(/\D/g, '')) || 0), status: 'pending', ...extra };
}

const comment = (id: string, content: string, s = 0): Comment => ({ id, content, authorId: 'bob@x', createdAt: at(s), type: 'COMMENT', resolved: false });

const DOC = 'Intro.\nMoved paragraph text.\nMiddle.\nEnd.';
const CUT = 'Intro.\nMiddle.\nEnd.';
const PASTED = 'Intro.\nMiddle.\nEnd.\nMoved paragraph text.';

describe('pending filter', () => {
  it('keeps only pending changes (a missing status counts as pending)', () => {
    const list = [change('c1', 'a', 'ab'), change('c2', 'a', 'ac', { status: 'approved' }), change('c3', 'a', 'ad', { status: 'rejected' }), { ...change('c4', 'a', 'ae'), status: undefined }];
    expect(pendingOnly(list).map((c) => c.id)).toEqual(['c1', 'c4']);
  });

  it('applied after merging local changes, a resolution that arrives later removes the change', () => {
    const server = [change('c1', 'a', 'ab')];
    const local = [change('c2', 'a', 'ac')];
    expect(pendingOnly(mergeLocalChanges(server, local, new Set())).map((c) => c.id)).toEqual(['c1', 'c2']);
    // Another user rejects c1, and c2's local copy gets a remote reject too
    const server2 = [{ ...server[0], status: 'rejected' as const }];
    const local2 = [{ ...local[0], status: 'rejected' as const }];
    expect(pendingOnly(mergeLocalChanges(server2, local2, new Set()))).toEqual([]);
  });

  it('status overrides (undo) bring a resolved change back', () => {
    const list = [change('c1', 'a', 'ab', { status: 'rejected' })];
    const overridden = applyStatusOverrides(list, new Map([['c1', 'pending' as const]]));
    expect(pendingOnly(overridden).map((c) => c.id)).toEqual(['c1']);
    expect(applyStatusOverrides(list, new Map())).toBe(list);
  });
});

describe('move pairing', () => {
  it('pairs a deletion and an insertion of the same text by the same author into one Moved card', () => {
    const cards = pairMoves([change('c1', DOC, CUT), change('c2', CUT, PASTED)]);
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('move');
    expect(cards[0].ids).toEqual(['c1', 'c2']); // deletion first
    expect(cards[0].description).toEqual({ kind: 'moved', text: 'Moved paragraph text.' });
  });

  it('pairs a paste that came first (copy, paste, then delete the original): deletion still first', () => {
    const copy = 'Intro.\nMoved paragraph text.\nMiddle.\nEnd.\nMoved paragraph text.';
    const cards = pairMoves([change('c1', DOC, copy), change('c2', copy, PASTED)]);
    expect(cards).toHaveLength(1);
    expect(cards[0].ids).toEqual(['c2', 'c1']);
  });

  it('ignores whitespace differences (line breaks, double spaces)', () => {
    const cards = pairMoves([
      change('c1', 'A.\nOne  two\nthree.\nB.', 'A.\nB.'),
      change('c2', 'A.\nB.', 'A.\nB.\nOne two three.'),
    ]);
    expect(cards.map((c) => c.type)).toEqual(['move']);
  });

  it('does not pair changes by different authors', () => {
    const cards = pairMoves([change('c1', DOC, CUT), change('c2', CUT, PASTED, { changedBy: 'carol@x' })]);
    expect(cards.map((c) => c.type)).toEqual(['change', 'change']);
    expect(cards.map((c) => c.description.kind)).toEqual(['deleted', 'added']);
  });

  it('does not pair different text, and pairs each change at most once', () => {
    const cards = pairMoves([
      change('c1', DOC, CUT),
      change('c2', CUT, PASTED),
      change('c3', PASTED, PASTED + '\nMoved paragraph text.'),
      change('c4', 'x y', 'x z y'),
    ]);
    expect(cards.map((c) => c.type)).toEqual(['move', 'change', 'change']);
  });
});

describe('document ordering of the Open list', () => {
  it('orders by position, unlocated items last in their original order', () => {
    const items = ['a', 'b', 'c', 'd'];
    const pos: Record<string, number | undefined> = { a: undefined, b: 30, c: undefined, d: 10 };
    expect(orderByPosition(items, (x) => pos[x])).toEqual(['d', 'b', 'a', 'c']);
  });

  it('merges pending changes and comment threads; a card goes at its earliest change', () => {
    const changes = [
      change('c1', DOC, CUT), // deletion of the moved paragraph (near the top)
      change('c2', CUT, PASTED), // the paste (at the end)
      change('c3', 'Intro.', 'Intro, edited.', {}),
      change('c4', 'x', 'xy'),
    ];
    const comments = [
      comment('k1', '@change:c3 Is this right?', 1),
      comment('k2', '@reply:k1 Yes.', 2),
      comment('k3', 'A general comment', 3),
      comment('k4', '@change:gone-change On a change that is resolved', 4),
    ];
    const positions = new Map([['c1', 50], ['c2', 400], ['c3', 10]]); // c4 can't be located
    const items = buildOpenItems(changes, comments, positions);
    expect(items.map((i) => i.key)).toEqual(['c3', 'move:c1:c2', 'c4', 'comment:k3', 'comment:k4']);
    const c3 = items[0];
    expect(c3.type === 'change' && c3.threads.map((t) => [t.id, t.replies.map((r) => r.id)])).toEqual([['k1', ['k2']]]);
  });

  it('a thread on a located (but not pending) change takes that position', () => {
    const items = buildOpenItems([change('c1', 'a b', 'a x b')], [comment('k1', '@change:c9 note')], new Map([['c1', 20], ['c9', 5]]));
    expect(items.map((i) => i.key)).toEqual(['comment:k1', 'c1']);
  });
});

describe('comment threads', () => {
  it('nests replies at any depth, oldest first', () => {
    const threads = buildCommentThreads([
      comment('r2', '@reply:r1 deeper', 3),
      comment('k1', 'root', 1),
      comment('r1', '@reply:k1 first reply', 2),
      comment('orphan', '@reply:missing lost reply', 4),
    ]);
    expect(threads.map((t) => t.id)).toEqual(['k1', 'orphan']);
    expect(threads[0].replies[0].id).toBe('r1');
    expect(threads[0].replies[0].replies[0].id).toBe('r2');
  });
});

describe('history', () => {
  it('lists decisions newest first with who decided; a move decided together is one entry', () => {
    const changes = [
      change('c1', DOC, CUT, { status: 'rejected', rejectedBy: 'help@x', rejectedByName: 'HelpDesk', rejectedAt: at(30) }),
      change('c2', CUT, PASTED, { status: 'rejected', rejectedBy: 'help@x', rejectedByName: 'HelpDesk', rejectedAt: at(31) }),
      change('c3', 'a', 'ab', { status: 'approved', approvedBy: 'bob@x', approvedByName: 'Bob', approvedAt: at(40) }),
      change('c4', 'a', 'ac'),
    ];
    const history = buildHistory(changes);
    expect(history.map((e) => [e.key, e.status, e.resolverName])).toEqual([
      ['approved:c3', 'approved', 'Bob'],
      ['rejected:move:c1:c2', 'rejected', 'HelpDesk'],
    ]);
    expect(history[1].ids).toEqual(['c1', 'c2']);
  });

  it('uses the local decision time when the record has none yet', () => {
    const history = buildHistory([change('c1', 'a', 'ab', { status: 'approved' })], new Map([['c1', 12345]]));
    expect(history[0].at).toBe(12345);
  });
});

describe('countOpenEdits (the Open tab and conditions popover count)', () => {
  it('counts a Moved card once, other changes once each, and comments not at all', () => {
    const changes = [change('c1', DOC, CUT), change('c2', CUT, PASTED), change('c3', 'Intro.', 'Intro, edited.')];
    expect(countOpenEdits(changes)).toBe(2);
    const items = buildOpenItems(changes, [comment('k1', 'A general comment')], new Map());
    expect(items).toHaveLength(3);
    expect(countOpenEdits(items)).toBe(2);
  });

  it('counts only pending change records', () => {
    expect(countOpenEdits([change('c1', DOC, CUT), change('c2', CUT, PASTED, { status: 'rejected' })])).toBe(1);
    expect(countOpenEdits([])).toBe(0);
  });
});

describe('findMovePartner', () => {
  it('finds the other half of a pending move', () => {
    const list = [change('c1', DOC, CUT), change('c2', CUT, PASTED)];
    expect(findMovePartner(list, 'c1')?.id).toBe('c2');
    expect(findMovePartner(list, 'c2')?.id).toBe('c1');
  });

  it('finds it when the halves disagree (the deletion rejected, the insertion pending)', () => {
    const list = [change('c1', DOC, CUT, { status: 'rejected' }), change('c2', CUT, PASTED)];
    expect(findMovePartner(list, 'c2')?.id).toBe('c1');
  });

  it('prefers the pending pairing (as the Open list shows it)', () => {
    // An older rejected deletion of the same text, and the pending move.
    const list = [change('c1', DOC, CUT, { status: 'rejected' }), change('c3', DOC, CUT), change('c4', CUT, PASTED)];
    expect(findMovePartner(list, 'c4')?.id).toBe('c3');
  });

  it('is undefined for a change that is not half of a move', () => {
    const list = [change('c1', 'a', 'ab'), change('c2', DOC, CUT)];
    expect(findMovePartner(list, 'c1')).toBeUndefined();
    expect(findMovePartner(list, 'c2')).toBeUndefined();
    expect(findMovePartner(list, 'missing')).toBeUndefined();
  });
});
