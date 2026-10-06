import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TransactionManager } from '../services/transactionManager';
import './SaveStatus.css';

/**
 * Save status for the tracked-changes editor, in words: "Unsaved changes" while an edit
 * is open, "Saving…" while it is sent, "Saved" once everything is stored, and
 * "Couldn't save" with a Retry button when a save failed (after the manager's own
 * automatic retry).
 *
 * There is no Save button. Edits are saved without one:
 * - after a short pause in typing (the TransactionManager's pause timer, 2.5 s),
 * - when the page is hidden (tab switch, window minimised, and on the way to closing),
 * - on pagehide / beforeunload, and
 * - when the editor unmounts (navigating away inside the app).
 * If an edit is still open or being saved when the page unloads, the browser is asked to
 * confirm leaving (the standard "changes may not be saved" prompt).
 */

export type SaveStatusState = 'saved' | 'unsaved' | 'saving' | 'error';

interface SaveStatusProps {
  transactionManager: TransactionManager;
  className?: string;
}

export function computeSaveState(tm: TransactionManager): SaveStatusState {
  const status = tm.getSaveStatus();
  // A later successful save clears the manager's error flag even though an earlier edit
  // is still unsaved, so check for failed transactions directly.
  if (status === 'error' || tm.getUndoStack().some((tx) => tx.status === 'failed')) return 'error';
  if (status === 'saving') return 'saving';
  if (tm.getActiveTransaction()) return 'unsaved';
  return 'saved';
}

const LABELS: Record<SaveStatusState, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  error: "Couldn't save",
};

const SaveStatus: React.FC<SaveStatusProps> = ({ transactionManager, className }) => {
  const tmRef = useRef(transactionManager);
  tmRef.current = transactionManager;
  const [state, setState] = useState<SaveStatusState>(() => computeSaveState(transactionManager));
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const tm = transactionManager;
    const update = () => setState(computeSaveState(tm));
    update();
    tm.on('active-transaction-changed', update);
    tm.on('save-status-changed', update);
    tm.on('transaction-settled', update);
    return () => {
      tm.off('active-transaction-changed', update);
      tm.off('save-status-changed', update);
      tm.off('transaction-settled', update);
    };
  }, [transactionManager]);

  // Save the open edit when the page is hidden or unloaded.
  useEffect(() => {
    const flush = () => { tmRef.current.flush(); };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      flush();
      if (computeSaveState(tmRef.current) !== 'saved') {
        e.preventDefault();
        // Older browsers need returnValue set to show the prompt.
        e.returnValue = '';
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  // Save the open edit when the editor unmounts. A layout-effect cleanup runs before any
  // passive-effect cleanup in the tree, so this happens before the editor destroys its
  // TransactionManager (TrackedChangesEditor does that in a passive effect).
  useLayoutEffect(() => () => { tmRef.current.flush(); }, []);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await tmRef.current.retryFailedSaves();
    } finally {
      setRetrying(false);
    }
  }, []);

  const label = retrying ? LABELS.saving : LABELS[state];
  return (
    <span className={`save-status save-status--${retrying ? 'saving' : state}${className ? ` ${className}` : ''}`} data-state={retrying ? 'saving' : state}>
      <span className="save-status__text" role="status" aria-live="polite">
        {state === 'saved' && !retrying && <i className="fas fa-check save-status__icon" aria-hidden="true" />}
        {state === 'error' && !retrying && <i className="fas fa-exclamation-circle save-status__icon" aria-hidden="true" />}
        {label}
      </span>
      {state === 'error' && !retrying && (
        <button type="button" className="save-status__retry" onClick={handleRetry}>
          Retry
        </button>
      )}
    </span>
  );
};

export default SaveStatus;
