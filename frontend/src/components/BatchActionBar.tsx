import React, { useState } from 'react';
import './BatchActionBar.css';

interface BatchActionBarProps {
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onApproveSelected: () => void;
  onRejectSelected: () => void;
  onApproveAll: () => void;
  onRejectAll: () => void;
  disabled?: boolean;
}

const BatchActionBar: React.FC<BatchActionBarProps> = ({
  selectedCount,
  totalCount,
  onSelectAll,
  onDeselectAll,
  onApproveSelected,
  onRejectSelected,
  onApproveAll,
  onRejectAll,
  disabled = false,
}) => {
  const [confirmAction, setConfirmAction] = useState<{
    type: 'approve' | 'reject';
    scope: 'selected' | 'all';
  } | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const allSelected = selectedCount === totalCount && totalCount > 0;

  const handleConfirm = () => {
    if (!confirmAction) return;
    if (confirmAction.scope === 'all') {
      if (confirmAction.type === 'approve') onApproveAll();
      else onRejectAll();
    } else {
      if (confirmAction.type === 'approve') onApproveSelected();
      else onRejectSelected();
    }
    setConfirmAction(null);
  };

  return (
    <div className="batch-action-bar">
      <div className="batch-action-bar__left">
        <label className="batch-action-bar__checkbox">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={allSelected ? onDeselectAll : onSelectAll}
            disabled={disabled || totalCount === 0}
          />
          <span className="batch-action-bar__count">
            {selectedCount > 0 ? `${selectedCount} selected` : 'Select all'}
          </span>
        </label>
      </div>

      <div className="batch-action-bar__actions">
        {selectedCount > 0 && (
          <>
            <button
              className="btn btn-sm batch-action-bar__btn batch-action-bar__btn--approve"
              onClick={() => setConfirmAction({ type: 'approve', scope: 'selected' })}
              disabled={disabled}
            >
              Approve Selected
            </button>
            <button
              className="btn btn-sm batch-action-bar__btn batch-action-bar__btn--reject"
              onClick={() => setConfirmAction({ type: 'reject', scope: 'selected' })}
              disabled={disabled}
            >
              Reject Selected
            </button>
          </>
        )}

        <div className="batch-action-bar__divider" />

        <button
          className="btn btn-sm batch-action-bar__btn batch-action-bar__btn--approve-all"
          onClick={() => setConfirmAction({ type: 'approve', scope: 'all' })}
          disabled={disabled || totalCount === 0}
        >
          Accept All
        </button>
        <button
          className="btn btn-sm batch-action-bar__btn batch-action-bar__btn--reject-all"
          onClick={() => setConfirmAction({ type: 'reject', scope: 'all' })}
          disabled={disabled || totalCount === 0}
        >
          Reject All
        </button>

        <button
          className="batch-action-bar__shortcuts-btn"
          onClick={() => setShowShortcuts(!showShortcuts)}
          title="Keyboard shortcuts"
        >
          <i className="far fa-keyboard" />
        </button>
      </div>

      {showShortcuts && (
        <div className="batch-action-bar__shortcuts-panel">
          <div className="batch-action-bar__shortcut"><kbd>j</kbd> Next change</div>
          <div className="batch-action-bar__shortcut"><kbd>k</kbd> Previous change</div>
          <div className="batch-action-bar__shortcut"><kbd>a</kbd> Approve current/selected</div>
          <div className="batch-action-bar__shortcut"><kbd>r</kbd> Reject current/selected</div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmAction && (
        <div className="batch-action-bar__confirm-overlay" onClick={() => setConfirmAction(null)}>
          <div className="batch-action-bar__confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h4>
              {confirmAction.type === 'approve' ? 'Approve' : 'Reject'}{' '}
              {confirmAction.scope === 'all' ? `all ${totalCount}` : selectedCount} change
              {(confirmAction.scope === 'all' ? totalCount : selectedCount) !== 1 ? 's' : ''}?
            </h4>
            <p>This action will {confirmAction.type} the {confirmAction.scope === 'all' ? 'entire set of' : 'selected'} tracked changes.</p>
            <div className="batch-action-bar__confirm-actions">
              <button className="btn btn-neutral btn-sm" onClick={() => setConfirmAction(null)}>
                Cancel
              </button>
              <button
                className={`btn btn-sm ${confirmAction.type === 'approve' ? 'btn-primary' : 'btn-danger'}`}
                onClick={handleConfirm}
              >
                {confirmAction.type === 'approve' ? 'Approve' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BatchActionBar;
