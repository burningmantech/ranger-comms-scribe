import React from 'react';
import { UserName } from '../UserName';
import { HistoryEntry, ReviewChangeLike, cardAuthor } from '../../utils/reviewItems';
import { ChangeDescriptionText } from './ChangeDescriptionText';
import { formatRelativeTime } from './time';

export interface HistoryListProps<T extends ReviewChangeLike> {
  entries: Array<HistoryEntry<T>>;
  canUndo: (entry: HistoryEntry<T>) => boolean;
  onUndo: (entry: HistoryEntry<T>) => void;
  /** Ids with an undo in progress (their Undo is disabled). */
  busyIds?: ReadonlySet<string>;
  fieldLabel: (field: string) => string | undefined;
}

/** Who accepted or rejected what, and when, newest first, with Undo where it's valid. */
export function HistoryList<T extends ReviewChangeLike>({ entries, canUndo, onUndo, busyIds, fieldLabel }: HistoryListProps<T>): JSX.Element {
  if (entries.length === 0) {
    return (
      <div className="rp-empty">
        <i className="far fa-clock" aria-hidden="true" />
        <div className="rp-empty__title">No decisions yet</div>
        <div className="rp-empty__text">Accepted and rejected changes show up here.</div>
      </div>
    );
  }
  return (
    <div className="rp-history">
      {entries.map((entry) => {
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
