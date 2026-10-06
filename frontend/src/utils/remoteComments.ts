import { Comment } from '../types/content';

/**
 * A comment another session posted, from a submission-room message, in the frontend's
 * Comment shape. Null when the message carries none.
 *
 * - `comment_added`: a submission comment (POST /content/submissions/:id/comments; a
 *   comment on a change is one of these with an `@change:<id>` reference), or a comment
 *   from the change comment endpoint, which carries `changeId` instead of the reference.
 * - `status_changed` with a comment: the note of a Request changes.
 */
export function remoteCommentFromMessage(message: { type?: string; data?: any } | null | undefined): Comment | null {
  if (!message || (message.type !== 'comment_added' && message.type !== 'status_changed')) return null;
  const raw = message.data?.comment;
  if (!raw || typeof raw !== 'object' || !raw.id || typeof raw.content !== 'string') return null;
  let content: string = raw.content;
  const changeId = message.data?.changeId || raw.changeId;
  if (changeId && !content.includes(`@change:${changeId}`)) content = `@change:${changeId} ${content}`;
  const created = raw.createdAt ? new Date(raw.createdAt) : new Date();
  return {
    id: raw.id,
    content,
    authorId: raw.authorId || '',
    createdAt: isNaN(created.getTime()) ? new Date() : created,
    type: raw.isSuggestion ? 'SUGGESTION' : 'COMMENT',
    resolved: !!raw.resolved,
    ...(raw.resolved ? { resolvedBy: raw.resolvedBy, resolvedByName: raw.resolvedByName, resolvedAt: raw.resolvedAt } : {}),
  };
}

/** The comments with `comment` added at the end, or the same array if it is there already. */
export function mergeComment(comments: Comment[], comment: Comment): Comment[] {
  return comments.some((c) => c.id === comment.id) ? comments : [...comments, comment];
}
