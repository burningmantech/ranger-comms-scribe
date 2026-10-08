/**
 * Keeping an open review page's submission status, approval gates and comment resolutions
 * current from the submission room, without refetching the whole submission (which would
 * replace the change list and proposed versions under the editor).
 *
 * The server tells the room after every tracked-change operation (`status_changed` when the
 * status changed, else `approval_state`, both with `approvalGates`), after an approval
 * (`approval_added` with `submissionStatus` and `approvalGates`) and after a comment thread
 * is resolved or reopened (`comment_resolved`). After the approvers list is changed
 * (PUT /submissions/:id/approvers) its `status_changed` / `approval_state` also carries
 * `requiredApprovers`, the list as saved.
 */
import type { ApprovalGates, Comment, ContentSubmission, SubmissionStatus } from '../types/content';

export interface RoomMessageLike {
  type?: string;
  data?: any;
}

export interface CommentResolution {
  commentId: string;
  resolved: boolean;
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: Date | string;
}

const STATUSES: ReadonlyArray<SubmissionStatus> = ['draft', 'submitted', 'in_review', 'approved', 'comms_approved', 'sent', 'rejected'];
const isStatus = (s: unknown): s is SubmissionStatus => typeof s === 'string' && (STATUSES as readonly string[]).includes(s);
const isGates = (g: unknown): g is ApprovalGates =>
  !!g && typeof g === 'object' && ['councilManager', 'commsCadre', 'requiredApprovers', 'trackedChanges'].every((k) => k in (g as any));

/** The comments with one thread resolved or reopened; the same array when nothing changes. */
export function applyCommentResolution(comments: Comment[], resolution: CommentResolution): Comment[] {
  const index = comments.findIndex((c) => c.id === resolution.commentId);
  if (index === -1) return comments;
  const current = comments[index];
  const next: Comment = { ...current, resolved: resolution.resolved };
  if (resolution.resolved) {
    next.resolvedBy = resolution.resolvedBy;
    next.resolvedByName = resolution.resolvedByName;
    next.resolvedAt = resolution.resolvedAt;
  } else {
    delete next.resolvedBy;
    delete next.resolvedByName;
    delete next.resolvedAt;
  }
  if (current.resolved === next.resolved && current.resolvedBy === next.resolvedBy &&
      String(current.resolvedAt ?? '') === String(next.resolvedAt ?? '')) return comments;
  const out = comments.slice();
  out[index] = next;
  return out;
}

/** The resolution a `comment_resolved` message carries, or null. */
export function commentResolutionFromMessage(message: RoomMessageLike | null | undefined): CommentResolution | null {
  if (!message || message.type !== 'comment_resolved') return null;
  const d = message.data;
  if (!d || typeof d.commentId !== 'string' || typeof d.resolved !== 'boolean') return null;
  return { commentId: d.commentId, resolved: d.resolved, resolvedBy: d.resolvedBy, resolvedByName: d.resolvedByName, resolvedAt: d.resolvedAt };
}

/**
 * The submission with what a room message says about its status, gates or comments
 * applied. Returns the same object when the message changes nothing.
 */
export function applyReviewStateMessage(submission: ContentSubmission, message: RoomMessageLike): ContentSubmission {
  const resolution = commentResolutionFromMessage(message);
  if (resolution) {
    const comments = applyCommentResolution(submission.comments, resolution);
    return comments === submission.comments ? submission : { ...submission, comments };
  }
  const data = message?.data || {};
  let status: unknown;
  if (message?.type === 'status_changed' || message?.type === 'approval_state') status = data.status;
  else if (message?.type === 'approval_added') status = data.submissionStatus;
  else return submission;
  const gates = isGates(data.approvalGates) ? data.approvalGates : undefined;
  const statusChanges = isStatus(status) && status !== submission.status;
  const approvers: string[] | undefined = message?.type !== 'approval_added' && Array.isArray(data.requiredApprovers) &&
    data.requiredApprovers.every((e: unknown) => typeof e === 'string') ? data.requiredApprovers : undefined;
  const current = submission.requiredApprovers || [];
  const approversChange = !!approvers && (approvers.length !== current.length || approvers.some((e, i) => e !== current[i]));
  if (!statusChanges && !gates && !approversChange) return submission;
  return {
    ...submission,
    ...(statusChanges ? { status: status as SubmissionStatus } : {}),
    ...(gates ? { approvalGates: gates } : {}),
    ...(approversChange ? { requiredApprovers: approvers } : {}),
  };
}

/**
 * Whether a message calls for a refetch of the status and gates: a change decided in
 * another session (`change_status_updated`; the server's own `approval_state` normally
 * arrives too), a reconnect (pushes may have been missed), or a status message without gates.
 */
export function needsReviewStateRefresh(message: RoomMessageLike | null | undefined): boolean {
  if (!message?.type) return false;
  if (message.type === 'change_status_updated' || message.type === 'connection_restored') return true;
  if (message.type === 'status_changed' || message.type === 'approval_added' || message.type === 'approval_state') {
    return !isGates(message.data?.approvalGates);
  }
  return false;
}

/** The room message types an open review page listens to (see TrackedChangesEditor). */
export const REVIEW_STATE_MESSAGE_TYPES = [
  'status_changed',
  'approval_state',
  'approval_added',
  'comment_resolved',
  'change_status_updated',
  'connection_restored',
] as const;
