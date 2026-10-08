import type { ApprovalGates, Comment, ContentSubmission } from '../../types/content';
import {
  applyCommentResolution,
  applyReviewStateMessage,
  commentResolutionFromMessage,
  needsReviewStateRefresh,
} from '../reviewState';

const gates = (met: boolean, pending = met ? 0 : 1): ApprovalGates => ({
  councilManager: { met: true },
  commsCadre: { met: true },
  requiredApprovers: { met: true, approved: 1, total: 1, details: [] },
  trackedChanges: { met, pending, total: 1 },
});

const comment = (id: string, extra: Partial<Comment> = {}): Comment => ({
  id, content: 'note', authorId: 'bob@x', createdAt: new Date('2026-10-05T10:00:00Z'), type: 'COMMENT', resolved: false, ...extra,
});

function submission(extra: Partial<ContentSubmission> = {}): ContentSubmission {
  return {
    id: 's1', title: 'T', content: 'c', status: 'in_review', submittedBy: 'a', submittedAt: new Date(), formFields: [],
    comments: [comment('k1'), comment('k2')], approvals: [], changes: [], assignedReviewers: [], assignedCouncilManagers: [],
    suggestedEdits: [], requiredApprovers: [], approvalGates: gates(false), ...extra,
  };
}

describe('applyReviewStateMessage', () => {
  it('status_changed: the new status and gates (the Send button and "4/4 conditions met")', () => {
    const before = submission();
    const after = applyReviewStateMessage(before, { type: 'status_changed', data: { status: 'approved', previousStatus: 'in_review', approvalGates: gates(true) } });
    expect(after.status).toBe('approved');
    expect(after.approvalGates).toEqual(gates(true));
    expect(after.changes).toBe(before.changes);
    expect(after.comments).toBe(before.comments);
  });

  it('approval_state: the gates, status unchanged', () => {
    const after = applyReviewStateMessage(submission(), { type: 'approval_state', data: { status: 'in_review', approvalGates: gates(true) } });
    expect(after.status).toBe('in_review');
    expect(after.approvalGates?.trackedChanges.met).toBe(true);
  });

  it('approval_added: submissionStatus and gates', () => {
    const after = applyReviewStateMessage(submission(), { type: 'approval_added', data: { submissionStatus: 'approved', approvalGates: gates(true) } });
    expect(after.status).toBe('approved');
  });

  it('a Request changes note (status_changed without gates) sets the status only', () => {
    const before = submission({ status: 'approved' });
    const after = applyReviewStateMessage(before, { type: 'status_changed', data: { status: 'in_review', comment: { id: 'x' } } });
    expect(after.status).toBe('in_review');
    expect(after.approvalGates).toBe(before.approvalGates);
  });

  it('approval_state after an approvers change: the new approvers list too (F14)', () => {
    const before = submission({ requiredApprovers: [] });
    const after = applyReviewStateMessage(before, { type: 'approval_state', data: { status: 'in_review', approvalGates: gates(false), requiredApprovers: ['ira@x.org'] } });
    expect(after.requiredApprovers).toEqual(['ira@x.org']);
    // status_changed too; the same list again changes nothing
    const changed = applyReviewStateMessage(before, { type: 'status_changed', data: { status: 'in_review', requiredApprovers: ['ira@x.org'] } });
    expect(changed.requiredApprovers).toEqual(['ira@x.org']);
    const same = submission({ requiredApprovers: ['ira@x.org'], approvalGates: gates(false) });
    expect(applyReviewStateMessage(same, { type: 'approval_state', data: { status: 'in_review', requiredApprovers: ['ira@x.org'] } })).toBe(same);
    // Anything else (a message without the list, or a malformed one) leaves it alone
    expect(applyReviewStateMessage(same, { type: 'approval_state', data: { status: 'in_review', approvalGates: gates(false) } }).requiredApprovers).toEqual(['ira@x.org']);
    expect(applyReviewStateMessage(same, { type: 'approval_state', data: { status: 'in_review', requiredApprovers: 'ira@x.org' } })).toBe(same);
  });

  it('returns the same submission when nothing changes or the message is unrelated', () => {
    const before = submission();
    expect(applyReviewStateMessage(before, { type: 'approval_state', data: { status: 'in_review' } })).toBe(before);
    expect(applyReviewStateMessage(before, { type: 'status_changed', data: { status: 'bogus' } })).toBe(before);
    expect(applyReviewStateMessage(before, { type: 'cursor_position', data: { status: 'approved' } })).toBe(before);
  });

  it('comment_resolved: resolves and reopens the thread', () => {
    const before = submission();
    const resolved = applyReviewStateMessage(before, {
      type: 'comment_resolved',
      data: { commentId: 'k1', resolved: true, resolvedBy: 'rev@x', resolvedByName: 'Rev', resolvedAt: '2026-10-05T11:00:00Z' },
    });
    expect(resolved.comments[0]).toMatchObject({ id: 'k1', resolved: true, resolvedBy: 'rev@x', resolvedByName: 'Rev' });
    expect(resolved.comments[1]).toBe(before.comments[1]);
    const reopened = applyReviewStateMessage(resolved, { type: 'comment_resolved', data: { commentId: 'k1', resolved: false } });
    expect(reopened.comments[0].resolved).toBe(false);
    expect(reopened.comments[0].resolvedBy).toBeUndefined();
    // the same resolution again changes nothing
    expect(applyReviewStateMessage(reopened, { type: 'comment_resolved', data: { commentId: 'k1', resolved: false } })).toBe(reopened);
    // an unknown comment changes nothing
    expect(applyReviewStateMessage(before, { type: 'comment_resolved', data: { commentId: 'nope', resolved: true } })).toBe(before);
  });
});

describe('needsReviewStateRefresh', () => {
  it('refetches after a remote decision, a reconnect, or a status message without gates', () => {
    expect(needsReviewStateRefresh({ type: 'change_status_updated', data: { changeId: 'c1', status: 'approved' } })).toBe(true);
    expect(needsReviewStateRefresh({ type: 'connection_restored' })).toBe(true);
    expect(needsReviewStateRefresh({ type: 'status_changed', data: { status: 'in_review' } })).toBe(true);
    expect(needsReviewStateRefresh({ type: 'approval_added', data: { submissionStatus: 'in_review' } })).toBe(true);
  });
  it('not when the message carries the gates, nor for comments', () => {
    expect(needsReviewStateRefresh({ type: 'status_changed', data: { status: 'approved', approvalGates: gates(true) } })).toBe(false);
    expect(needsReviewStateRefresh({ type: 'approval_state', data: { status: 'in_review', approvalGates: gates(true) } })).toBe(false);
    expect(needsReviewStateRefresh({ type: 'comment_resolved', data: { commentId: 'k1', resolved: true } })).toBe(false);
    expect(needsReviewStateRefresh(null)).toBe(false);
  });
});

describe('comment resolutions', () => {
  it('reads one from a comment_resolved message only', () => {
    expect(commentResolutionFromMessage({ type: 'comment_resolved', data: { commentId: 'k1', resolved: true } })).toEqual(
      expect.objectContaining({ commentId: 'k1', resolved: true }),
    );
    expect(commentResolutionFromMessage({ type: 'comment_resolved', data: { commentId: 'k1' } })).toBeNull();
    expect(commentResolutionFromMessage({ type: 'comment_added', data: { commentId: 'k1', resolved: true } })).toBeNull();
  });

  it('applyCommentResolution keeps the array when nothing changes', () => {
    const comments = [comment('k1')];
    expect(applyCommentResolution(comments, { commentId: 'k1', resolved: false })).toBe(comments);
    expect(applyCommentResolution(comments, { commentId: 'k1', resolved: true, resolvedBy: 'x' })[0].resolved).toBe(true);
  });
});
