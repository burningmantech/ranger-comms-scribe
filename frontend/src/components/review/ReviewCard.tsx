import React from 'react';
import { UserName } from '../UserName';
import { useUserName } from '../../services/userDirectory';
import { getChangeColor } from '../../utils/userColors';
import { cardAuthor, cardTime, ChangeCard, OpenItem, ReviewChangeLike, threadSize } from '../../utils/reviewItems';
import { ChangeDescriptionText } from './ChangeDescriptionText';
import { CommentThread } from './CommentThread';
import { formatRelativeTime } from './time';

export interface ReviewCardProps<T extends ReviewChangeLike> {
  item: OpenItem<T>;
  currentUserId?: string;
  canReview: boolean;
  selected: boolean;
  /** The pointer is over this item's text in the editor. */
  linked: boolean;
  disabled?: boolean;
  fieldLabel: (field: string) => string | undefined;
  onSelect: (item: OpenItem<T>) => void;
  onHover?: (item: OpenItem<T> | null) => void;
  onAccept: (card: ChangeCard<T>) => void;
  onReject: (card: ChangeCard<T>) => void;
  onComment: (changeId: string) => void;
  onReply: (parentId: string, text: string) => void;
}

/** The author's initial in their highlight color (the color of their text in the editor). */
const Avatar: React.FC<{ value: string; color: string }> = ({ value, color }) => {
  const name = useUserName(value);
  return (
    <span className="rp-card__avatar" style={{ backgroundColor: color }} aria-hidden="true">
      {(name || value || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
};

/** A pending change (or a move) with Accept / Reject, or a comment thread, in the Open list. */
export function ReviewCard<T extends ReviewChangeLike>(props: ReviewCardProps<T>): JSX.Element {
  const { item, canReview, selected, linked, disabled, onSelect, onHover, onReply } = props;
  const classes = ['rp-card', 'change-item', selected ? 'selected' : '', linked ? 'rp-card--linked' : ''];

  if (item.type === 'comment') {
    return (
      <div
        className={[...classes, 'rp-card--comment'].join(' ')}
        data-item-key={item.key}
        data-change-ids={item.ids.join(' ')}
        onClick={() => onSelect(item)}
        onMouseEnter={() => onHover?.(item)}
        onMouseLeave={() => onHover?.(null)}
      >
        <div className="rp-card__kind"><i className="far fa-comment" aria-hidden="true" /> Comment{item.changeId ? ' on a resolved change' : ''}</div>
        <CommentThread thread={item.thread} onReply={onReply} />
      </div>
    );
  }

  const author = cardAuthor(item);
  const changes = item.type === 'move' ? [item.deletion, item.insertion] : [item.change];
  const field = changes[0].field;
  const label = field && field !== 'content' ? props.fieldLabel(field) : undefined;
  const color = getChangeColor(author, props.currentUserId);
  const when = new Date(cardTime(item));
  const commentCount = item.threads.reduce((n, t) => n + threadSize(t), 0);

  return (
    <div
      className={classes.join(' ')}
      style={{ borderLeftColor: color }}
      data-item-key={item.key}
      data-change-id={item.ids[0]}
      data-change-ids={item.ids.join(' ')}
      onClick={() => onSelect(item)}
      onMouseEnter={() => onHover?.(item)}
      onMouseLeave={() => onHover?.(null)}
    >
      <div className="rp-card__header">
        <Avatar value={author} color={color} />
        <div className="rp-card__who">
          <UserName className="rp-card__author change-author" value={author} />
          <span className="rp-card__time" title={when.toLocaleString()}>{formatRelativeTime(when)}</span>
        </div>
        {canReview && (
          <div className="rp-card__actions">
            <button
              type="button"
              className="rp-icon-btn rp-icon-btn--accept"
              title="Accept"
              aria-label="Accept"
              disabled={disabled}
              onClick={(e) => { e.stopPropagation(); props.onAccept(item); }}
            >
              <i className="fas fa-check" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="rp-icon-btn rp-icon-btn--reject"
              title="Reject"
              aria-label="Reject"
              disabled={disabled}
              onClick={(e) => { e.stopPropagation(); props.onReject(item); }}
            >
              <i className="fas fa-times" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      {label && <div className="rp-card__field">{label}</div>}
      <ChangeDescriptionText description={item.description} />
      <div className="rp-card__footer">
        <button
          type="button"
          className="rp-link-btn"
          title="Add comment"
          onClick={(e) => { e.stopPropagation(); props.onComment(item.ids[item.ids.length - 1]); }}
        >
          <i className="far fa-comment" aria-hidden="true" /> Comment
        </button>
        {commentCount > 0 && <span className="rp-card__count">{commentCount} comment{commentCount === 1 ? '' : 's'}</span>}
      </div>
      {item.threads.length > 0 && (
        <div className="rp-card__threads" onClick={(e) => e.stopPropagation()}>
          {item.threads.map((t) => <CommentThread key={t.id} thread={t} onReply={onReply} />)}
        </div>
      )}
    </div>
  );
}

export default ReviewCard;
