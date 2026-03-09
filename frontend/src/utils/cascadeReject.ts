/**
 * cascadeReject — reverses an entire dependency chain when a tracked change
 * is rejected or undone.
 *
 * Steps:
 * 1. Fetch cascade dependencies from the backend.
 * 2. Walk the dependent chain in reverse chronological order (newest first).
 * 3. For each dependent change: delete from backend, remove decorations,
 *    and remove from the undo stack if present.
 * 4. Delete the originally rejected change itself.
 * 5. Restore the editor to the pre-chain state.
 * 6. Return the list of all removed change IDs (for WebSocket broadcast).
 */

import { trackedChangesService } from '../services/trackedChangesService';
import { removeDecorationsForChange } from '../components/editor/plugins/TrackedChangesPlugin';
import { TransactionManager, Transaction } from '../services/transactionManager';

export interface CascadeRejectOptions {
  submissionId: string;
  changeId: string;
  /** Optional TransactionManager instance — used to clean up the undo stack. */
  transactionManager?: TransactionManager | null;
  /** Callback to refetch submission content when no snapshot is available. Optional args: removed changes. */
  refetchSubmissionContent?: (removedIds?: string[]) => Promise<void>;
  /**
   * Override for getCascadeDependencies (useful for testing).
   * Defaults to trackedChangesService.getCascadeDependencies.
   */
  getCascadeDependencies?: (
    submissionId: string,
    changeId: string,
  ) => Promise<{ changeId: string; dependentIds: string[] }>;
  /**
   * Override for deleteTrackedChange (useful for testing).
   * Defaults to trackedChangesService.deleteTrackedChange.
   */
  deleteTrackedChange?: (submissionId: string, changeId: string) => Promise<void>;
  /**
   * Override for removeDecorationsForChange (useful for testing).
   * Defaults to the TrackedChangesPlugin export.
   */
  removeDecorations?: (changeId: string) => void;
}

export interface CascadeRejectResult {
  /** All change IDs that were removed (dependents + the original). */
  removedChangeIds: string[];
  /** Change IDs where the backend delete failed (best-effort). */
  failedDeleteIds: string[];
}

/**
 * Execute a cascade rejection for a tracked change and all its dependents.
 */
export async function cascadeReject(
  options: CascadeRejectOptions,
): Promise<CascadeRejectResult> {
  const {
    submissionId,
    changeId,
    transactionManager,
    refetchSubmissionContent,
    getCascadeDependencies = (sid, cid) =>
      trackedChangesService.getCascadeDependencies(sid, cid),
    deleteTrackedChange = (sid, cid) =>
      trackedChangesService.deleteTrackedChange(sid, cid),
    removeDecorations = removeDecorationsForChange,
  } = options;

  const removedChangeIds: string[] = [];
  const failedDeleteIds: string[] = [];

  // 1. Fetch the cascade dependency chain
  const { dependentIds } = await getCascadeDependencies(submissionId, changeId);

  // 2. Reverse the dependents (newest first) and process each
  const reversedDependents = [...dependentIds].reverse();

  for (const depId of reversedDependents) {
    // Delete from backend (best effort — continue on failure)
    try {
      await deleteTrackedChange(submissionId, depId);
    } catch (err) {
      console.error(`cascadeReject: failed to delete dependent change ${depId}`, err);
      failedDeleteIds.push(depId);
    }

    // Remove visual decorations
    try {
      removeDecorations(depId);
    } catch (err) {
      console.error(`cascadeReject: failed to remove decorations for ${depId}`, err);
    }

    // Remove from undo stack if present
    if (transactionManager) {
      removeFromUndoStack(transactionManager, depId);
    }

    removedChangeIds.push(depId);
  }

  // 3. Handle the originally rejected change
  try {
    await deleteTrackedChange(submissionId, changeId);
  } catch (err) {
    console.error(`cascadeReject: failed to delete original change ${changeId}`, err);
    failedDeleteIds.push(changeId);
  }

  try {
    removeDecorations(changeId);
  } catch (err) {
    console.error(`cascadeReject: failed to remove decorations for ${changeId}`, err);
  }

  if (transactionManager) {
    removeFromUndoStack(transactionManager, changeId);
  }

  removedChangeIds.push(changeId);

  // 4. Restore editor to pre-chain state
  if (refetchSubmissionContent) {
    // Rely on native UI resolution (dispatching resolve events) for all changes
    await refetchSubmissionContent(removedChangeIds);
  }

  return { removedChangeIds, failedDeleteIds };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Remove a transaction from the TransactionManager's undo stack
 * by matching its remoteChangeId.
 *
 * We access the undo stack via `getUndoStack()` and then reconstruct
 * the stack without the matching entry by popping and re-pushing.
 * This is slightly indirect because the stack is encapsulated, but
 * the TransactionManager exposes `getUndoStack()` for reading
 * and `undo()` / `redo()` for manipulation.
 *
 * Since there is no direct "removeFromStack" method, we record
 * which remoteChangeIds to skip. The undo() call handles remote
 * deletion already, so we just need to call undo() if the target
 * is on top. For entries that are NOT on top, we mark the
 * transaction's remoteChangeId as null so subsequent undo() calls
 * won't try to delete it again.
 */
function removeFromUndoStack(
  manager: TransactionManager,
  remoteChangeId: string,
): void {
  const stack = manager.getUndoStack();
  for (const tx of stack) {
    if (tx.remoteChangeId === remoteChangeId) {
      // Null out the remoteChangeId so that if the user later calls undo(),
      // the TransactionManager won't try to delete the already-deleted
      // remote change.
      tx.remoteChangeId = null;
    }
  }
}

