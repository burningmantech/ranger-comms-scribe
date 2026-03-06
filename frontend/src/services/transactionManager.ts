/**
 * TransactionManager — manages the tracked-change transaction lifecycle,
 * pause detection, session undo/redo stack, and autosave coordination.
 *
 * Transaction lifecycle: active -> settled -> saved
 *
 * This is a plain TypeScript class (no React dependency) that uses an
 * EventEmitter-style API so it can be consumed from hooks or contexts.
 */

import { trackedChangesService, TrackedChangeResponse } from './trackedChangesService';
import { extractTextFromLexical } from '../utils/lexicalUtils';
import { diffCharsOptimized } from '../utils/diffAlgorithm';
import { API_URL } from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransactionStatus = 'active' | 'settled' | 'saved' | 'failed';
export type SaveStatus = 'all-saved' | 'saving' | 'error';

export type TransactionEvent =
  | 'transaction-settled'
  | 'transaction-saved'
  | 'save-error'
  | 'transaction-undone'
  | 'transaction-redone'
  | 'save-status-changed';

export interface RegionRange {
  start: number;
  end: number;
}

export interface RegionMap {
  field: string;
  ranges: RegionRange[];
}

export interface TransactionSnapshot {
  /** The Lexical JSON state (serialized or object) */
  lexicalState: string | object;
  /** Extracted plain text (computed automatically) */
  text: string;
}

export interface Transaction {
  id: string;
  field: string;
  status: TransactionStatus;
  beforeSnapshot: TransactionSnapshot;
  afterSnapshot: TransactionSnapshot | null;
  regionMap: RegionMap | null;
  createdAt: number;
  settledAt: number | null;
  savedAt: number | null;
  /** The server-side tracked change ID after a successful save */
  remoteChangeId: string | null;
}

type EventHandler = (...args: any[]) => void;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_UNDO_DEPTH = 50;
const AUTOSAVE_RETRY_DELAY_MS = 2000;
const DEFAULT_PAUSE_DELAY_MS = 2500;

// ---------------------------------------------------------------------------
// TransactionManager
// ---------------------------------------------------------------------------

export class TransactionManager {
  // Current active transaction (at most one)
  private activeTransaction: Transaction | null = null;

  // Session undo / redo stacks (ephemeral, cleared on session end)
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];

  // Saving state tracking
  private savingCount = 0;
  private hasError = false;

  // Event listeners
  private listeners: Map<TransactionEvent, Set<EventHandler>> = new Map();

  // Submission context
  private submissionId: string;

  // Allow dependency injection for testing
  private saveFunction: (
    submissionId: string,
    change: { field: string; oldValue: string; newValue: string; regionMap?: RegionMap },
  ) => Promise<TrackedChangeResponse>;

  private deleteFunction: (
    submissionId: string,
    changeId: string,
  ) => Promise<void>;

  private retryDelayMs: number;

  // Pause detection state
  private pauseDelayMs: number;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private latestAfterLexicalState: string | object | null = null;

  constructor(
    submissionId: string,
    options?: {
      saveFunction?: (
        submissionId: string,
        change: { field: string; oldValue: string; newValue: string; regionMap?: RegionMap },
      ) => Promise<TrackedChangeResponse>;
      deleteFunction?: (submissionId: string, changeId: string) => Promise<void>;
      /** Override the retry delay (default 2000ms). Set to 0 for tests. */
      retryDelayMs?: number;
      /** Override the pause/inactivity delay (default 2500ms). */
      pauseDelayMs?: number;
    },
  ) {
    this.submissionId = submissionId;
    this.retryDelayMs = options?.retryDelayMs ?? AUTOSAVE_RETRY_DELAY_MS;
    this.pauseDelayMs = options?.pauseDelayMs ?? DEFAULT_PAUSE_DELAY_MS;

    // Default save function delegates to trackedChangesService
    this.saveFunction =
      options?.saveFunction ??
      ((sid, change) => trackedChangesService.createTrackedChange(sid, change));

    // Default delete function calls the DELETE endpoint directly
    this.deleteFunction =
      options?.deleteFunction ??
      (async (sid, changeId) => {
        const sessionId = localStorage.getItem('sessionId');
        const response = await fetch(
          `${API_URL}/tracked-changes/submission/${sid}/change/${changeId}`,
          {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              Authorization: sessionId ? `Bearer ${sessionId}` : '',
            },
          },
        );
        if (!response.ok) {
          throw new Error(`Failed to delete tracked change: ${response.statusText}`);
        }
      });
  }

  // -----------------------------------------------------------------------
  // EventEmitter API
  // -----------------------------------------------------------------------

  on(event: TransactionEvent, handler: EventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(event: TransactionEvent, handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(event: TransactionEvent, ...args: any[]): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (err) {
          console.error(`TransactionManager event handler error (${event}):`, err);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Transaction lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start a new active transaction.
   * Captures the "before" snapshot (Lexical JSON + extracted text).
   * Starting a new transaction clears the redo stack.
   */
  startTransaction(field: string, beforeLexicalState: string | object): Transaction {
    // If there is already an active transaction, settle it first with the
    // before snapshot (effectively a no-op change).
    if (this.activeTransaction) {
      this.settleTransaction(this.activeTransaction.beforeSnapshot.lexicalState);
    }

    const beforeText = extractTextFromLexical(beforeLexicalState);
    const transaction: Transaction = {
      id: generateId(),
      field,
      status: 'active',
      beforeSnapshot: {
        lexicalState: beforeLexicalState,
        text: beforeText,
      },
      afterSnapshot: null,
      regionMap: null,
      createdAt: Date.now(),
      settledAt: null,
      savedAt: null,
      remoteChangeId: null,
    };

    this.activeTransaction = transaction;

    // Starting a new transaction clears the redo stack
    this.redoStack = [];

    return transaction;
  }

  /**
   * Notify the manager that the editor content has changed.
   * Resets the inactivity (pause) timer. When the timer fires
   * after `pauseDelayMs` of inactivity, the active transaction
   * is automatically settled with the most recent state.
   *
   * If there is no active transaction, this call is a no-op
   * (the editor should call `startTransaction` first).
   */
  notifyActivity(afterLexicalState: string | object): void {
    if (!this.activeTransaction) {
      return;
    }

    // Store the latest state so the auto-settle uses the right snapshot
    this.latestAfterLexicalState = afterLexicalState;

    // Reset the debounce timer
    this.cancelPauseTimer();
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (this.activeTransaction && this.latestAfterLexicalState != null) {
        this.settleTransaction(this.latestAfterLexicalState);
      }
    }, this.pauseDelayMs);
  }

  /**
   * Settle the currently active transaction.
   * Computes the diff & region map, pushes onto undo stack,
   * and triggers autosave. If a pause timer is pending, it is cancelled.
   */
  settleTransaction(afterLexicalState: string | object): Transaction | null {
    // Cancel any pending pause timer — we are settling explicitly
    this.cancelPauseTimer();
    this.latestAfterLexicalState = null;

    if (!this.activeTransaction) {
      return null;
    }

    const tx = this.activeTransaction;
    const afterText = extractTextFromLexical(afterLexicalState);

    tx.afterSnapshot = {
      lexicalState: afterLexicalState,
      text: afterText,
    };

    // Compute region map
    tx.regionMap = this.computeRegionMap(
      tx.field,
      tx.beforeSnapshot.text,
      afterText,
    );

    tx.status = 'settled';
    tx.settledAt = Date.now();

    // Push onto undo stack
    this.pushTransaction(tx);

    // Clear active reference
    this.activeTransaction = null;

    this.emit('transaction-settled', tx);

    // Trigger autosave (fire-and-forget — errors are handled internally)
    this.autosave(tx);

    return tx;
  }

  /**
   * Return the currently active (unsettled) transaction, or null.
   */
  getActiveTransaction(): Transaction | null {
    return this.activeTransaction;
  }

  // -----------------------------------------------------------------------
  // Region map computation (delegates to module-level utility)
  // -----------------------------------------------------------------------

  private computeRegionMap(field: string, beforeText: string, afterText: string): RegionMap {
    return computeRegionMap(beforeText, afterText, field);
  }

  // -----------------------------------------------------------------------
  // Session undo / redo stack
  // -----------------------------------------------------------------------

  /**
   * Push a settled/saved transaction onto the undo stack.
   */
  private pushTransaction(tx: Transaction): void {
    this.undoStack.push(tx);
    if (this.undoStack.length > MAX_UNDO_DEPTH) {
      this.undoStack.shift();
    }
  }

  /**
   * Pop the most recent transaction from the undo stack (for undo).
   * Returns the transaction to reverse, or null if nothing to undo.
   * Moves the popped transaction to the redo stack.
   */
  undo(): Transaction | null {
    const tx = this.undoStack.pop() ?? null;
    if (tx) {
      this.redoStack.push(tx);

      // If the transaction was saved remotely, fire a delete request to clean up
      if (tx.remoteChangeId) {
        this.deleteRemoteChange(tx);
      }

      this.emit('transaction-undone', tx);
    }
    return tx;
  }

  /**
   * Re-apply a previously undone transaction.
   * Returns the transaction to re-apply, or null if nothing to redo.
   */
  redo(): Transaction | null {
    const tx = this.redoStack.pop() ?? null;
    if (tx) {
      this.undoStack.push(tx);

      // Re-save the transaction
      this.autosave(tx);

      this.emit('transaction-redone', tx);
    }
    return tx;
  }

  /**
   * Peek at the top of the undo stack without modifying it.
   */
  peekTransaction(): Transaction | null {
    return this.undoStack.length > 0
      ? this.undoStack[this.undoStack.length - 1]
      : null;
  }

  /**
   * Return a shallow copy of the undo stack.
   */
  getUndoStack(): Transaction[] {
    return [...this.undoStack];
  }

  /**
   * Return a shallow copy of the redo stack.
   */
  getRedoStack(): Transaction[] {
    return [...this.redoStack];
  }

  // -----------------------------------------------------------------------
  // Autosave coordination
  // -----------------------------------------------------------------------

  /**
   * Return the current aggregate save status.
   */
  getSaveStatus(): SaveStatus {
    if (this.hasError) return 'error';
    if (this.savingCount > 0) return 'saving';
    return 'all-saved';
  }

  private async autosave(tx: Transaction): Promise<void> {
    if (!tx.afterSnapshot) return;

    // Skip saving if before and after text are identical
    if (tx.beforeSnapshot.text === tx.afterSnapshot.text) return;

    this.savingCount++;
    this.emitSaveStatus();

    try {
      const response = await this.saveFunction(this.submissionId, {
        field: tx.field,
        oldValue: tx.beforeSnapshot.text,
        newValue: tx.afterSnapshot.text,
        regionMap: tx.regionMap ?? undefined,
      });

      tx.status = 'saved';
      tx.savedAt = Date.now();
      tx.remoteChangeId = response.id;

      this.savingCount--;
      // Clear the error flag if there are no more pending saves with errors
      if (this.savingCount === 0) {
        this.hasError = false;
      }
      this.emitSaveStatus();
      this.emit('transaction-saved', tx);
    } catch (err) {
      // Retry once after delay
      if (this.retryDelayMs > 0) {
        await delay(this.retryDelayMs);
      }
      try {
        const response = await this.saveFunction(this.submissionId, {
          field: tx.field,
          oldValue: tx.beforeSnapshot.text,
          newValue: tx.afterSnapshot!.text,
          regionMap: tx.regionMap ?? undefined,
        });

        tx.status = 'saved';
        tx.savedAt = Date.now();
        tx.remoteChangeId = response.id;

        this.savingCount--;
        if (this.savingCount === 0) {
          this.hasError = false;
        }
        this.emitSaveStatus();
        this.emit('transaction-saved', tx);
      } catch (retryErr) {
        tx.status = 'failed';
        this.savingCount--;
        this.hasError = true;
        this.emitSaveStatus();
        this.emit('save-error', tx, retryErr);
      }
    }
  }

  private async deleteRemoteChange(tx: Transaction): Promise<void> {
    if (!tx.remoteChangeId) return;
    try {
      await this.deleteFunction(this.submissionId, tx.remoteChangeId);
      tx.remoteChangeId = null;
    } catch (err) {
      console.error('TransactionManager: failed to delete remote change', err);
    }
  }

  private emitSaveStatus(): void {
    this.emit('save-status-changed', this.getSaveStatus());
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Clear all ephemeral session state. Call when the session ends.
   */
  destroy(): void {
    this.cancelPauseTimer();
    this.latestAfterLexicalState = null;
    this.activeTransaction = null;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners.clear();
    this.savingCount = 0;
    this.hasError = false;
  }

  // -----------------------------------------------------------------------
  // Pause detection internals
  // -----------------------------------------------------------------------

  private cancelPauseTimer(): void {
    if (this.pauseTimer !== null) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Public utility: computeRegionMap
// ---------------------------------------------------------------------------

/**
 * Compute a RegionMap describing which character ranges in the "after" text
 * were affected by the diff from `beforeText` to `afterText`.
 *
 * Exported so it can be reused by cascade rejection and other consumers.
 */
export function computeRegionMap(beforeText: string, afterText: string, field: string): RegionMap {
  const segments = diffCharsOptimized(beforeText, afterText);
  const ranges: RegionRange[] = [];

  // Walk through the *new* text position to record affected ranges
  let newPos = 0;
  for (const seg of segments) {
    if (seg.type === 'equal') {
      newPos += seg.value.length;
    } else if (seg.type === 'insert') {
      ranges.push({ start: newPos, end: newPos + seg.value.length });
      newPos += seg.value.length;
    } else if (seg.type === 'delete') {
      // Record a zero-width range at the deletion point in the new text
      ranges.push({ start: newPos, end: newPos });
    }
  }

  // Merge overlapping/adjacent ranges
  return { field, ranges: mergeRanges(ranges) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function generateId(): string {
  return `tx-${Date.now()}-${++idCounter}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Merge overlapping / adjacent ranges into a minimal set.
 */
function mergeRanges(ranges: RegionRange[]): RegionRange[] {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: RegionRange[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }

  return merged;
}
