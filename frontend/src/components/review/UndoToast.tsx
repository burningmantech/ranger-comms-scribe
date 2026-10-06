import React from 'react';

export interface UndoToastProps {
  /** "Rejected", "Accepted", "Accepted 4 changes", ... */
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  busy?: boolean;
}

/** A short-lived, non-blocking "Rejected · Undo" toast after a decision. */
export const UndoToast: React.FC<UndoToastProps> = ({ message, onUndo, onDismiss, busy }) => (
  <div className="rp-undo-toast" role="status" aria-live="polite">
    <span className="rp-undo-toast__message">{message}</span>
    <span className="rp-undo-toast__sep" aria-hidden="true">·</span>
    <button type="button" className="rp-undo-toast__undo" onClick={onUndo} disabled={busy}>
      Undo
    </button>
    <button type="button" className="rp-undo-toast__close" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
      <i className="fas fa-times" aria-hidden="true" />
    </button>
  </div>
);

export default UndoToast;
