import { mergeComment, remoteCommentFromMessage } from '../remoteComments';
import { buildOpenItems, commentChangeId } from '../reviewItems';
import { Comment } from '../../types/content';

const serverComment = {
  id: 'c1',
  submissionId: 'sub-1',
  content: '@change:ch1 Why this word?',
  authorId: 'u2',
  authorName: 'Reviewer',
  createdAt: '2026-10-05T10:00:00.000Z',
  isSuggestion: false,
  resolved: false,
};

describe('remoteCommentFromMessage', () => {
  it('maps a comment_added message (submission comment on a change)', () => {
    const c = remoteCommentFromMessage({ type: 'comment_added', data: { comment: serverComment, title: 'T' } });
    expect(c).toEqual({
      id: 'c1',
      content: '@change:ch1 Why this word?',
      authorId: 'u2',
      createdAt: new Date('2026-10-05T10:00:00.000Z'),
      type: 'COMMENT',
      resolved: false,
    });
    expect(commentChangeId(c!)).toBe('ch1');
  });

  it('adds the @change reference for a comment from the change comment endpoint', () => {
    const raw = { id: 'c2', changeId: 'ch9', submissionId: 'sub-1', content: 'Hm', authorId: 'u2', createdAt: '2026-10-05T10:00:00.000Z' };
    const c = remoteCommentFromMessage({ type: 'comment_added', data: { comment: raw, changeId: 'ch9' } });
    expect(c?.content).toBe('@change:ch9 Hm');
    expect(commentChangeId(c!)).toBe('ch9');
  });

  it('maps the note of a Request changes (status_changed with a comment)', () => {
    const note = { ...serverComment, id: 'n1', content: 'Please shorten the intro.' };
    const c = remoteCommentFromMessage({ type: 'status_changed', data: { status: 'in_review', comment: note } });
    expect(c?.id).toBe('n1');
    expect(c?.content).toBe('Please shorten the intro.');
  });

  it('ignores messages without a comment', () => {
    expect(remoteCommentFromMessage({ type: 'status_changed', data: { status: 'approved' } })).toBeNull();
    expect(remoteCommentFromMessage({ type: 'change_status_updated', data: { comment: serverComment } })).toBeNull();
    expect(remoteCommentFromMessage(null)).toBeNull();
  });
});

describe('mergeComment', () => {
  it('adds a new comment once, so it shows on its change card in the Open list', () => {
    const c = remoteCommentFromMessage({ type: 'comment_added', data: { comment: serverComment } })!;
    const before: Comment[] = [];
    const once = mergeComment(before, c);
    const twice = mergeComment(once, c);
    expect(once).toHaveLength(1);
    expect(twice).toBe(once);

    const change = { id: 'ch1', field: 'content', oldValue: 'a', newValue: 'b', changedBy: 'u1', timestamp: '2026-10-05T09:00:00.000Z', status: 'pending' as const };
    const items = buildOpenItems([change], once, new Map());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('change');
    expect((items[0] as any).threads.map((t: Comment) => t.id)).toEqual(['c1']);
  });
});
