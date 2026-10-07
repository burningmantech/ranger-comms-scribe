import React, { useState } from 'react';
import { UserName } from '../UserName';
import { CommentNode, commentText } from '../../utils/reviewItems';
import { formatRelativeTime } from './time';

interface CommentThreadProps {
  thread: CommentNode;
  /** Post a reply to a comment (any comment in the thread). Without it (History) the thread is read-only. */
  onReply?: (parentId: string, text: string) => void;
  /** Resolve the thread (shown on its root comment). */
  onResolve?: (threadId: string) => void;
}

interface CommentEntryProps {
  node: CommentNode;
  depth: number;
  onReply?: CommentThreadProps['onReply'];
  onResolve?: CommentThreadProps['onResolve'];
}

/** One comment and its replies, with an inline reply box. */
const CommentEntry: React.FC<CommentEntryProps> = ({ node, depth, onReply, onResolve }) => {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim() || !onReply) return;
    onReply(node.id, text.trim());
    setText('');
    setReplying(false);
  };
  return (
    <div className={`rp-comment ${depth > 0 ? 'rp-comment--reply' : ''}`}>
      <div className="rp-comment__header">
        <UserName className="rp-comment__author" value={node.authorId} />
        <span className="rp-comment__time" title={new Date(node.createdAt).toLocaleString()}>
          {formatRelativeTime(new Date(node.createdAt))}
        </span>
        {depth === 0 && onResolve && (
          <button
            type="button"
            className="rp-icon-btn rp-comment__resolve"
            title="Resolve"
            aria-label="Resolve comment thread"
            onClick={(e) => { e.stopPropagation(); onResolve(node.id); }}
          >
            <i className="fas fa-check" aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="rp-comment__body">{commentText(node)}</div>
      {onReply && !replying && (
        <button
          type="button"
          className="rp-link-btn"
          onClick={(e) => { e.stopPropagation(); setReplying(true); }}
        >
          Reply
        </button>
      )}
      {replying && (
        <div className="rp-reply-form" onClick={(e) => e.stopPropagation()}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write a reply…"
            aria-label="Reply"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              if (e.key === 'Escape') setReplying(false);
            }}
          />
          <div className="rp-reply-form__actions">
            <button type="button" className="btn btn-sm btn-neutral" onClick={() => { setReplying(false); setText(''); }}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={submit} disabled={!text.trim()}>
              Reply
            </button>
          </div>
        </div>
      )}
      {node.replies.length > 0 && (
        <div className="rp-comment__replies">
          {node.replies.map((r) => <CommentEntry key={r.id} node={r} depth={depth + 1} onReply={onReply} />)}
        </div>
      )}
    </div>
  );
};

export const CommentThread: React.FC<CommentThreadProps> = ({ thread, onReply, onResolve }) => (
  <div className="rp-thread" data-thread-id={thread.id}>
    <CommentEntry node={thread} depth={0} onReply={onReply} onResolve={onResolve} />
  </div>
);

export default CommentThread;
