import React, { useEffect, useRef, useState, useCallback } from 'react';
import { TransactionManager, SaveStatus, Transaction } from '../services/transactionManager';
import { trackedChangesService } from '../services/trackedChangesService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrphanedTransaction {
  field: string;
  oldValue: string;
  newValue: string;
  regionMap?: { field: string; ranges: Array<{ start: number; end: number }> };
  settledAt: number;
}

type VisualState = 'saved' | 'saving' | 'just-saved' | 'error';

interface SaveIndicatorProps {
  /** The TransactionManager instance for this editing session. */
  transactionManager: TransactionManager;
  /** The submission ID — used for beforeunload persistence and orphan recovery. */
  submissionId: string;
  /**
   * Callback to obtain the latest Lexical editor state.
   * Called during beforeunload to settle any active transaction.
   */
  getLatestEditorState?: () => string | object | null;
}

// ---------------------------------------------------------------------------
// localStorage key helper
// ---------------------------------------------------------------------------

export function orphanedKey(submissionId: string): string {
  return `tce-orphaned-${submissionId}`;
}

// ---------------------------------------------------------------------------
// SaveIndicator Component
// ---------------------------------------------------------------------------

const SaveIndicator: React.FC<SaveIndicatorProps> = ({
  transactionManager,
  submissionId,
  getLatestEditorState,
}) => {
  const [visualState, setVisualState] = useState<VisualState>('saved');
  const justSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tmRef = useRef(transactionManager);
  tmRef.current = transactionManager;

  // Keep getLatestEditorState stable across renders
  const getLatestRef = useRef(getLatestEditorState);
  getLatestRef.current = getLatestEditorState;

  // -------------------------------------------------------------------
  // Subscribe to save-status-changed from TransactionManager
  // -------------------------------------------------------------------
  useEffect(() => {
    const tm = tmRef.current;

    const handleStatusChange = (status: SaveStatus) => {
      // Clear any pending just-saved timer
      if (justSavedTimerRef.current) {
        clearTimeout(justSavedTimerRef.current);
        justSavedTimerRef.current = null;
      }

      switch (status) {
        case 'saving':
          setVisualState('saving');
          break;
        case 'error':
          setVisualState('error');
          break;
        case 'all-saved':
          // Brief "just-saved" state, then back to saved
          setVisualState('just-saved');
          justSavedTimerRef.current = setTimeout(() => {
            setVisualState('saved');
            justSavedTimerRef.current = null;
          }, 2000);
          break;
      }
    };

    tm.on('save-status-changed', handleStatusChange);

    return () => {
      tm.off('save-status-changed', handleStatusChange);
      if (justSavedTimerRef.current) {
        clearTimeout(justSavedTimerRef.current);
      }
    };
  }, [transactionManager]);

  // -------------------------------------------------------------------
  // beforeunload — settle active transaction + persist orphans
  // -------------------------------------------------------------------
  useEffect(() => {
    const handler = () => {
      const tm = tmRef.current;

      // 1. If there is an active transaction, settle it with the latest state
      const active = tm.getActiveTransaction();
      if (active && getLatestRef.current) {
        const latestState = getLatestRef.current();
        if (latestState != null) {
          tm.settleTransaction(latestState);
        }
      }

      // 2. Collect unsaved (settled-but-not-yet-saved) transactions from the undo stack
      const unsaved = tm.getUndoStack().filter(
        (tx: Transaction) => tx.status === 'settled' || tx.status === 'failed',
      );

      if (unsaved.length === 0) return;

      // 3. Try sendBeacon for fire-and-forget save
      const sessionId = localStorage.getItem('sessionId');
      const payload = JSON.stringify({
        changes: unsaved.map((tx: Transaction) => ({
          field: tx.field,
          oldValue: tx.beforeSnapshot.text,
          newValue: tx.afterSnapshot?.text ?? '',
          regionMap: tx.regionMap ?? undefined,
        })),
      });

      if (navigator.sendBeacon) {
        const url = `${process.env.REACT_APP_API_URL || 'https://scrivenly.com/api'}/tracked-changes/submission/${submissionId}/batch`;
        const blob = new Blob([payload], { type: 'application/json' });
        // sendBeacon doesn't support custom headers — the batch endpoint
        // should accept the session from a cookie or the beacon payload.
        // As a fallback we still persist to localStorage below.
        try {
          navigator.sendBeacon(url, blob);
        } catch {
          // Swallow — localStorage fallback below.
        }
      }

      // 4. Persist to localStorage as the reliable path
      const orphans: OrphanedTransaction[] = unsaved.map((tx: Transaction) => ({
        field: tx.field,
        oldValue: tx.beforeSnapshot.text,
        newValue: tx.afterSnapshot?.text ?? '',
        regionMap: tx.regionMap ?? undefined,
        settledAt: tx.settledAt ?? Date.now(),
      }));

      try {
        const key = orphanedKey(submissionId);
        const existing = localStorage.getItem(key);
        const merged = existing
          ? [...(JSON.parse(existing) as OrphanedTransaction[]), ...orphans]
          : orphans;
        localStorage.setItem(key, JSON.stringify(merged));
      } catch {
        // localStorage may be full or unavailable — nothing more we can do.
      }
    };

    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [submissionId]);

  // -------------------------------------------------------------------
  // Orphaned transaction recovery on mount
  // -------------------------------------------------------------------
  const recoverOrphans = useCallback(async () => {
    const key = orphanedKey(submissionId);
    const raw = localStorage.getItem(key);
    if (!raw) return;

    let orphans: OrphanedTransaction[];
    try {
      orphans = JSON.parse(raw) as OrphanedTransaction[];
    } catch {
      // Corrupt data — clean up
      localStorage.removeItem(key);
      return;
    }

    if (orphans.length === 0) {
      localStorage.removeItem(key);
      return;
    }

    try {
      await trackedChangesService.batchCreate(
        submissionId,
        orphans.map((o) => ({
          field: o.field,
          oldValue: o.oldValue,
          newValue: o.newValue,
          regionMap: o.regionMap,
        })),
      );
      // Success — clean up localStorage
      localStorage.removeItem(key);
    } catch {
      // Leave in localStorage for next attempt — do nothing
    }
  }, [submissionId]);

  useEffect(() => {
    recoverOrphans();
  }, [recoverOrphans]);

  // -------------------------------------------------------------------
  // Render — inline SVG cloud icon
  // -------------------------------------------------------------------

  return (
    <span
      className={`save-indicator save-indicator--${visualState}`}
      title={
        visualState === 'saved'
          ? 'All changes saved'
          : visualState === 'saving'
          ? 'Saving...'
          : visualState === 'just-saved'
          ? 'Saved'
          : 'Save failed — will retry'
      }
      role="status"
      aria-label={
        visualState === 'saved'
          ? 'All changes saved'
          : visualState === 'saving'
          ? 'Saving changes'
          : visualState === 'just-saved'
          ? 'Changes saved'
          : 'Save failed'
      }
    >
      {/* Cloud icon */}
      <svg
        className="save-indicator__cloud"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M19.35 10.04C18.67 6.59 15.64 4 12 4C9.11 4 6.6 5.64 5.35 8.04C2.34 8.36 0 10.91 0 14C0 17.31 2.69 20 6 20H19C21.76 20 24 17.76 24 15C24 12.36 21.95 10.22 19.35 10.04Z"
          fill="currentColor"
        />
      </svg>

      {/* Checkmark overlay — visible only in just-saved state */}
      {visualState === 'just-saved' && (
        <svg
          className="save-indicator__check"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"
            fill="currentColor"
          />
        </svg>
      )}

      {/* Warning dot — visible only in error state */}
      {visualState === 'error' && (
        <span className="save-indicator__warning-dot" aria-hidden="true" />
      )}

      <style>{saveIndicatorStyles}</style>
    </span>
  );
};

// ---------------------------------------------------------------------------
// Scoped CSS (injected inline to avoid external stylesheet dependency)
// ---------------------------------------------------------------------------

const saveIndicatorStyles = `
.save-indicator {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: #80868b;
  transition: color 0.3s ease;
}

/* Default: static cloud (all saved) */
.save-indicator--saved {
  color: #80868b;
}

/* Saving: subtle pulse */
.save-indicator--saving {
  color: #1a73e8;
  animation: si-pulse 1.2s ease-in-out infinite;
}

/* Just saved: cloud with checkmark, fades back */
.save-indicator--just-saved {
  color: #1e8e3e;
  animation: si-fade-check 2s ease forwards;
}

/* Error: cloud with warning dot */
.save-indicator--error {
  color: #d93025;
}

/* Cloud SVG base */
.save-indicator__cloud {
  display: block;
}

/* Checkmark overlay (positioned inside the cloud) */
.save-indicator__check {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -40%);
  color: #fff;
  animation: si-check-in 0.3s ease-out;
}

/* Warning dot (small circle at top-right of cloud) */
.save-indicator__warning-dot {
  position: absolute;
  top: 2px;
  right: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: #d93025;
  border: 1.5px solid #fff;
}

/* Animations */
@keyframes si-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes si-fade-check {
  0% { color: #1e8e3e; }
  70% { color: #1e8e3e; }
  100% { color: #80868b; }
}

@keyframes si-check-in {
  0% { transform: translate(-50%, -40%) scale(0); opacity: 0; }
  100% { transform: translate(-50%, -40%) scale(1); opacity: 1; }
}
`;

export default SaveIndicator;
