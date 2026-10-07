import React from 'react';
import { UserName } from '../UserName';
import { HistoryEntry, ResolvedThreadEntry, ReviewChangeLike, cardAuthor } from '../../utils/reviewItems';
import { ChangeDescriptionText } from './ChangeDescriptionText';
import { CommentThread } from './CommentThread';
import { formatRelativeTime } from './time';

export interface HistoryListProps<T extends ReviewChangeLike> {
  entries: Array<HistoryEntry<T>>;
  canUndo: (entry: HistoryEntry<T>) => boolean;
  onUndo: (entry: HistoryEntry<T>) => void;
  /** Ids with an undo in progress (their Undo is disabled). */
  busyIds?: ReadonlySet<string>;
  fieldLabel: (field: string) => string | undefined;
  /** Resolved comment threads, listed with the decisions by time. */
  resolvedThreads?: ResolvedThreadEntry[];
  /** Reopen a resolved thread (back to Open). */
  onReopen?: (threadId: string) => void;
}

/** A resolved comment thread: who resolved it, the thread (read-only) and Reopen. */
const ResolvedThreadItem: React.FC<{ entry: ResolvedThreadEntry; onReopen?: (threadId: string) => void }> = ({ entry, onReopen }) => (
  <div className="rp-history__item rp-history__item--resolved" data-resolved-thread-id={entry.thread.id}>
    <div className="rp-history__header">
      <span className="rp-history__status rp-history__status--resolved">
        <i className="fas fa-check-circle" aria-hidden="true" />
        {' Resolved by '}
        <UserName value={entry.resolverId} name={entry.resolverName} />
      </span>
      {entry.at > 0 && (
        <span className="rp-history__time" title={new Date(entry.at).toLocaleString()}>
          {formatRelativeTime(new Date(entry.at))}
        </span>
      )}
    </div>
    {entry.changeId && <div className="rp-card__field">Comment on a change</div>}
    <CommentThread thread={entry.thread} />
    {onReopen && (
      <div className="rp-history__footer">
        <span />
        <button type="button" className="rp-link-btn rp-history__reopen" onClick={() => onReopen(entry.thread.id)}>
          <i className="fas fa-redo" aria-hidden="true" /> Reopen
        </button>
      </div>
    )}
  </div>
);

type Row<T extends ReviewChangeLike> = { kind: 'decision'; at: number; entry: HistoryEntry<T> } | { kind: 'resolved'; at: number; entry: ResolvedThreadEntry };

/**
 * Who accepted or rejected what, and when, newest first, with Undo where it's valid; and
 * the resolved comment threads (with Reopen), in the same timeline.
 */
export function HistoryList<T extends ReviewChangeLike>({ entries, canUndo, onUndo, busyIds, fieldLabel, resolvedThreads = [], onReopen }: HistoryListProps<T>): JSX.Element {
  if (entries.length === 0 && resolvedThreads.length === 0) {
    return (
      <div className="rp-empty">
        <i className="far fa-clock" aria-hidden="true" />
        <div className="rp-empty__title">No decisions yet</div>
        <div className="rp-empty__text">Accepted and rejected changes and resolved comments show up here.</div>
      </div>
    );
  }
  const rows: Array<Row<T>> = [
    ...entries.map((entry) => ({ kind: 'decision' as const, at: entry.at, entry })),
    ...resolvedThreads.map((entry) => ({ kind: 'resolved' as const, at: entry.at, entry })),
  ];
  // Stable: decisions keep their order among themselves, as do resolved threads
  rows.sort((x, y) => y.at - x.at);
  return (
    <div className="rp-history">
      {rows.map((row) => {
        if (row.kind === 'resolved') return <ResolvedThreadItem key={row.entry.key} entry={row.entry} onReopen={onReopen} />;
        const entry = row.entry;
        const first = entry.card.type === 'move' ? entry.card.deletion : entry.card.change;
        const label = first.field && first.field !== 'content' ? fieldLabel(first.field) : undefined;
        const busy = entry.ids.some((id) => busyIds?.has(id));
        return (
          <div key={entry.key} className={`rp-history__item rp-history__item--${entry.status}`} data-history-ids={entry.ids.join(' ')}>
            <div className="rp-history__header">
              <span className={`rp-history__status rp-history__status--${entry.status}`}>
                <i className={`fas ${entry.status === 'approved' ? 'fa-check' : 'fa-times'}`} aria-hidden="true" />
                {entry.status === 'approved' ? ' Accepted by ' : ' Rejected by '}
                <UserName value={entry.resolverId} name={entry.resolverName} />
              </span>
              {entry.at > 0 && (
                <span className="rp-history__time" title={new Date(entry.at).toLocaleString()}>
                  {formatRelativeTime(new Date(entry.at))}
                </span>
              )}
            </div>
            {label && <div className="rp-card__field">{label}</div>}
            <ChangeDescriptionText description={entry.card.description} />
            <div className="rp-history__footer">
              <span className="rp-history__author">
                Change by <UserName value={cardAuthor(entry.card)} />
              </span>
              {canUndo(entry) && (
                <button
                  type="button"
                  className="rp-link-btn rp-history__undo"
                  disabled={busy}
                  onClick={() => onUndo(entry)}
                >
                  <i className="fas fa-undo" aria-hidden="true" /> Undo
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default HistoryList;
