import React, { useEffect, useRef, useState } from 'react';
import { ChangeCard, HistoryEntry, OpenItem, ResolvedThreadEntry, ReviewChangeLike } from '../../utils/reviewItems';
import { ReviewCard } from './ReviewCard';
import { HistoryList } from './HistoryList';
import './ReviewPanel.css';

export type ReviewTab = 'open' | 'history';

export interface ReviewPanelProps<T extends ReviewChangeLike> {
  tab: ReviewTab;
  onTabChange: (tab: ReviewTab) => void;
  openItems: Array<OpenItem<T>>;
  history: Array<HistoryEntry<T>>;
  pendingCount: number;
  canReview: boolean;
  currentUserId?: string;
  selectedKey?: string | null;
  /** Change ids whose text the pointer is over in the editor. */
  linkedIds?: ReadonlySet<string>;
  /** A decision or bulk action is in progress. */
  busy?: boolean;
  undoBusyIds?: ReadonlySet<string>;
  fieldLabel: (field: string) => string | undefined;
  onSelect: (item: OpenItem<T>) => void;
  onHover?: (item: OpenItem<T> | null) => void;
  onAccept: (card: ChangeCard<T>) => void;
  onReject: (card: ChangeCard<T>) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  /** Open the comment box: on a change, or a general comment (null). */
  onComment: (changeId: string | null) => void;
  onReply: (parentId: string, text: string) => void;
  canUndo: (entry: HistoryEntry<T>) => boolean;
  onUndo: (entry: HistoryEntry<T>) => void;
  /** Resolved comment threads (History, with Reopen). */
  resolvedThreads?: ResolvedThreadEntry[];
  /** Resolve (true) or reopen (false) a comment thread. Without it there is no Resolve / Reopen. */
  onResolveThread?: (threadId: string, resolved: boolean) => void;
  /** Rendered at the end of the header (e.g. the sidebar's collapse button). */
  headerExtra?: React.ReactNode;
}

/**
 * The review sidebar: "Open" (pending changes and unresolved comments, in document order)
 * and "History" (decisions, with Undo, and resolved comment threads, with Reopen). Bulk actions and the keyboard shortcuts are in the
 * ⋯ menu.
 */
export function ReviewPanel<T extends ReviewChangeLike>(props: ReviewPanelProps<T>): JSX.Element {
  const { tab, onTabChange, openItems, history, pendingCount, canReview, busy } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [confirm, setConfirm] = useState<'accept' | 'reject' | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const commentCount = openItems.filter((i) => i.type === 'comment').length;

  return (
    <div className="rp-panel">
      <div className="rp-header">
        <div className="rp-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'open'}
            className={`rp-tab ${tab === 'open' ? 'active' : ''}`}
            onClick={() => onTabChange('open')}
          >
            Open
            {pendingCount > 0 && <span className="rp-tab__count" title={`${pendingCount} pending change${pendingCount === 1 ? '' : 's'}`}>{pendingCount}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'history'}
            className={`rp-tab ${tab === 'history' ? 'active' : ''}`}
            onClick={() => onTabChange('history')}
          >
            History
          </button>
        </div>
        <div className="rp-menu" ref={menuRef}>
          <button
            type="button"
            className="rp-icon-btn rp-menu__trigger"
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <i className="fas fa-ellipsis-h" aria-hidden="true" />
          </button>
          {menuOpen && (
            <div className="rp-menu__list" role="menu">
              {canReview && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="rp-menu__item"
                    disabled={busy || pendingCount === 0}
                    onClick={() => { setMenuOpen(false); setConfirm('accept'); }}
                  >
                    <i className="fas fa-check-double" aria-hidden="true" /> Accept all
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="rp-menu__item"
                    disabled={busy || pendingCount === 0}
                    onClick={() => { setMenuOpen(false); setConfirm('reject'); }}
                  >
                    <i className="fas fa-times" aria-hidden="true" /> Reject all
                  </button>
                  <div className="rp-menu__divider" />
                </>
              )}
              <button
                type="button"
                role="menuitem"
                className="rp-menu__item"
                onClick={() => { setMenuOpen(false); props.onComment(null); }}
              >
                <i className="far fa-comment" aria-hidden="true" /> Add a comment
              </button>
              <button
                type="button"
                role="menuitem"
                className="rp-menu__item"
                onClick={() => { setMenuOpen(false); setShowShortcuts((v) => !v); }}
              >
                <i className="far fa-keyboard" aria-hidden="true" /> Keyboard shortcuts
              </button>
            </div>
          )}
        </div>
        {props.headerExtra}
      </div>

      {showShortcuts && (
        <div className="rp-shortcuts">
          <button type="button" className="rp-shortcuts__close" onClick={() => setShowShortcuts(false)} aria-label="Close shortcuts">
            <i className="fas fa-times" aria-hidden="true" />
          </button>
          <div><kbd>j</kbd> Next item</div>
          <div><kbd>k</kbd> Previous item</div>
          <div><kbd>a</kbd> Accept the selected change</div>
          <div><kbd>r</kbd> Reject the selected change</div>
        </div>
      )}

      <div className="rp-body">
        {tab === 'open' ? (
          openItems.length === 0 ? (
            <div className="rp-empty">
              <i className="far fa-check-circle" aria-hidden="true" />
              <div className="rp-empty__title">All caught up</div>
              <div className="rp-empty__text">No changes or comments waiting for review.</div>
            </div>
          ) : (
            <div className="rp-list changes-list">
              {pendingCount === 0 && commentCount > 0 && (
                <div className="rp-note">All changes reviewed. Open comments:</div>
              )}
              {openItems.map((item) => (
                <ReviewCard
                  key={item.key}
                  item={item}
                  currentUserId={props.currentUserId}
                  canReview={canReview}
                  selected={props.selectedKey === item.key}
                  linked={!!props.linkedIds && item.ids.some((id) => props.linkedIds!.has(id))}
                  disabled={busy}
                  fieldLabel={props.fieldLabel}
                  onSelect={props.onSelect}
                  onHover={props.onHover}
                  onAccept={props.onAccept}
                  onReject={props.onReject}
                  onComment={props.onComment}
                  onReply={props.onReply}
                  onResolveThread={props.onResolveThread ? (id) => props.onResolveThread!(id, true) : undefined}
                />
              ))}
            </div>
          )
        ) : (
          <HistoryList
            entries={history}
            canUndo={props.canUndo}
            onUndo={props.onUndo}
            busyIds={props.undoBusyIds}
            fieldLabel={props.fieldLabel}
            resolvedThreads={props.resolvedThreads}
            onReopen={props.onResolveThread ? (id) => props.onResolveThread!(id, false) : undefined}
          />
        )}
      </div>

      {confirm && (
        <div className="rp-confirm-overlay" onClick={() => setConfirm(null)}>
          <div className="rp-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h4>{confirm === 'accept' ? 'Accept' : 'Reject'} all {pendingCount} change{pendingCount === 1 ? '' : 's'}?</h4>
            <p>You can undo this from the toast or from History.</p>
            <div className="rp-confirm__actions">
              <button type="button" className="btn btn-sm btn-neutral" onClick={() => setConfirm(null)}>Cancel</button>
              <button
                type="button"
                className={`btn btn-sm ${confirm === 'accept' ? 'btn-primary' : 'btn-danger'}`}
                onClick={() => {
                  const which = confirm;
                  setConfirm(null);
                  if (which === 'accept') props.onAcceptAll();
                  else props.onRejectAll();
                }}
              >
                {confirm === 'accept' ? 'Accept all' : 'Reject all'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ReviewPanel;
