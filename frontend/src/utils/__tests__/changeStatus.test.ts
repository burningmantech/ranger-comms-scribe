import { applyChangeStatus, mergeLocalChanges, resolvedChangeIds } from '../changeStatus';
import type { Change } from '../../types/content';

function change(id: string, extra: Partial<Change> = {}): Change {
  return {
    id,
    field: 'content',
    oldValue: 'a',
    newValue: 'b',
    changedBy: 'author-id',
    timestamp: new Date(0),
    status: 'pending',
    ...extra,
  };
}

describe('applyChangeStatus', () => {
  test('marks matching changes rejected with who rejected them', () => {
    const changes = [change('c1'), change('c2'), change('c3')];
    const next = applyChangeStatus(changes, ['c1', 'c3'], 'rejected', { id: 'bob@example.com', name: 'Bob' });

    expect(next.map((c) => c.status)).toEqual(['rejected', 'pending', 'rejected']);
    expect(next[0]).toMatchObject({ rejectedBy: 'bob@example.com', rejectedByName: 'Bob' });
    expect(next[1]).toBe(changes[1]);
    // the input is not mutated
    expect(changes[0].status).toBe('pending');
  });

  test('marks matching changes approved with who approved them', () => {
    const next = applyChangeStatus([change('c1')], ['c1'], 'approved', { id: 'ann-id', name: 'Ann' });
    expect(next[0]).toMatchObject({ status: 'approved', approvedBy: 'ann-id', approvedByName: 'Ann' });
    expect(next[0].rejectedBy).toBeUndefined();
  });

  test('keeps existing resolver fields when no resolver is given', () => {
    const next = applyChangeStatus([change('c1', { rejectedBy: 'x', rejectedByName: 'X' })], ['c1'], 'rejected');
    expect(next[0]).toMatchObject({ status: 'rejected', rejectedBy: 'x', rejectedByName: 'X' });
  });

  test('returns the same array when no change matches', () => {
    const changes = [change('c1')];
    expect(applyChangeStatus(changes, ['other'], 'rejected')).toBe(changes);
    expect(applyChangeStatus(changes, [], 'rejected')).toBe(changes);
  });

  test('successive updates build on each other (functional state updates)', () => {
    // Two remote rejects applied one after the other must both stick; the old
    // handler reset to a stale snapshot, so only the last one survived.
    let state = [change('c1'), change('c2')];
    state = applyChangeStatus(state, ['c1'], 'rejected', { id: 'b' });
    state = applyChangeStatus(state, ['c2'], 'rejected', { id: 'b' });
    expect(state.map((c) => c.status)).toEqual(['rejected', 'rejected']);
  });
});

describe('resolvedChangeIds', () => {
  test('returns the explicit change id', () => {
    expect(resolvedChangeIds({ changeId: 'c1', status: 'approved' })).toEqual(['c1']);
  });

  test('adds cascade-rejected ids for a reject, without duplicates or junk', () => {
    expect(
      resolvedChangeIds({ changeId: 'c1', status: 'rejected', cascadeRejectedIds: ['c2', 'c1', '', 7, 'c3', 'c2'] }),
    ).toEqual(['c1', 'c2', 'c3']);
  });

  test('ignores cascade ids on an approve', () => {
    expect(resolvedChangeIds({ changeId: 'c1', status: 'approved', cascadeRejectedIds: ['c2'] })).toEqual(['c1']);
  });

  test('returns nothing for a malformed message', () => {
    expect(resolvedChangeIds(undefined)).toEqual([]);
    expect(resolvedChangeIds({ status: 'rejected' })).toEqual([]);
  });
});

describe('mergeLocalChanges', () => {
  test('appends local changes the server does not have yet, keeping their status', () => {
    const server = [change('s1')];
    const local = [change('l1', { status: 'rejected', rejectedBy: 'b' })];
    const merged = mergeLocalChanges(server, local, new Set());
    expect(merged.map((c) => [c.id, c.status])).toEqual([['s1', 'pending'], ['l1', 'rejected']]);
  });

  test('the server copy wins when both have a change', () => {
    const server = [change('c1', { status: 'rejected', rejectedBy: 'bob-id', rejectedByName: 'Bob' })];
    const local = [change('c1', { status: 'pending' })];
    const merged = mergeLocalChanges(server, local, new Set());
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(server[0]);
  });

  test('drops removed ids from both lists', () => {
    const merged = mergeLocalChanges([change('s1'), change('s2')], [change('l1')], new Set(['s1', 'l1']));
    expect(merged.map((c) => c.id)).toEqual(['s2']);
  });
});
