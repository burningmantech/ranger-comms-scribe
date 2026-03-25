/**
 * Tests for TransactionHistoryPlugin.
 *
 * Since Lexical requires a live browser DOM and React rendering context,
 * these tests focus on the transaction-level undo/redo logic by exercising
 * the TransactionManager interactions that the plugin would trigger.
 *
 * The tests validate:
 * 1. When a transaction is active, undo/redo should be delegated to Lexical
 *    (return false — tested via TransactionManager state).
 * 2. When idle, undo pops from the undo stack and returns the transaction.
 * 3. When idle, redo pops from the redo stack and returns the transaction.
 * 4. Undo of a saved transaction triggers remote delete.
 * 5. Redo re-triggers autosave.
 * 6. Undo/redo with empty stacks returns null.
 */

import {
  TransactionManager,
  Transaction,
} from '../../../../services/transactionManager';
import { TrackedChangeResponse } from '../../../../services/trackedChangesService';

// ---------------------------------------------------------------------------
// Helpers (shared with transactionManager.test.ts patterns)
// ---------------------------------------------------------------------------

function makeLexical(text: string): object {
  const paragraphs = text.split('\n').map((line) => ({
    type: 'paragraph',
    children: [{ type: 'text', text: line }],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  }));
  return {
    root: {
      children: paragraphs,
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  };
}

function makeSuccessSave(): jest.Mock<Promise<TrackedChangeResponse>> {
  let callCount = 0;
  return jest.fn(async (_sid: string, change: any) => {
    callCount++;
    return {
      id: `remote-${callCount}`,
      submissionId: _sid,
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      changedBy: 'user1',
      changedByName: 'User One',
      timestamp: new Date().toISOString(),
      status: 'pending' as const,
      comments: [],
    };
  });
}

function makeDeleteFn(): jest.Mock {
  return jest.fn(async () => {});
}

/**
 * Helper: create a TransactionManager, start a transaction, settle it,
 * and wait for autosave to complete.
 */
async function createSettledTransaction(
  manager: TransactionManager,
  beforeText: string,
  afterText: string,
): Promise<Transaction> {
  manager.startTransaction('content', makeLexical(beforeText));
  const tx = manager.settleTransaction(makeLexical(afterText));
  if (!tx) throw new Error('settleTransaction returned null');
  // Allow autosave promise to resolve
  await flushPromises();
  return tx;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests: TransactionManager undo/redo behavior
// (these verify the contract that TransactionHistoryPlugin relies on)
// ---------------------------------------------------------------------------

describe('TransactionHistoryPlugin — TransactionManager integration', () => {
  let manager: TransactionManager;
  let saveFn: jest.Mock;
  let deleteFn: jest.Mock;

  beforeEach(() => {
    saveFn = makeSuccessSave();
    deleteFn = makeDeleteFn();
    manager = new TransactionManager('sub-1', {
      saveFunction: saveFn,
      deleteFunction: deleteFn,
      retryDelayMs: 0,
      pauseDelayMs: 100_000, // Large delay so auto-settle doesn't fire
    });
  });

  afterEach(() => {
    manager.destroy();
  });

  // -----------------------------------------------------------------------
  // Active transaction detection
  // -----------------------------------------------------------------------

  describe('active transaction detection', () => {
    it('returns non-null when a transaction is active', () => {
      manager.startTransaction('content', makeLexical('hello'));
      expect(manager.getActiveTransaction()).not.toBeNull();
    });

    it('returns null after a transaction is settled', async () => {
      await createSettledTransaction(manager, 'hello', 'hello world');
      expect(manager.getActiveTransaction()).toBeNull();
    });

    it('returns null when no transaction has been started', () => {
      expect(manager.getActiveTransaction()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Transaction-level undo
  // -----------------------------------------------------------------------

  describe('undo', () => {
    it('returns null when undo stack is empty', () => {
      const result = manager.undo();
      expect(result).toBeNull();
    });

    it('pops the most recent transaction from the undo stack', async () => {
      const tx = await createSettledTransaction(manager, 'hello', 'hello world');
      expect(manager.getUndoStack()).toHaveLength(1);

      const undone = manager.undo();
      expect(undone).toBe(tx);
      expect(manager.getUndoStack()).toHaveLength(0);
    });

    it('moves the undone transaction to the redo stack', async () => {
      const tx = await createSettledTransaction(manager, 'hello', 'hello world');

      manager.undo();
      expect(manager.getRedoStack()).toHaveLength(1);
      expect(manager.getRedoStack()[0]).toBe(tx);
    });

    it('fires DELETE for a saved transaction', async () => {
      const tx = await createSettledTransaction(manager, 'hello', 'hello world');
      // After autosave, remoteChangeId should be set
      expect(tx.remoteChangeId).toBeTruthy();
      const savedRemoteId = tx.remoteChangeId;

      manager.undo();
      await flushPromises();

      // deleteRemoteChange nullifies tx.remoteChangeId after success,
      // so we check using the captured value.
      expect(deleteFn).toHaveBeenCalledWith('sub-1', savedRemoteId);
    });

    it('does not fire DELETE for an unsaved transaction', async () => {
      // Use a save function that never resolves during the test
      const neverSave = jest.fn(() => new Promise<TrackedChangeResponse>(() => {}));
      const localManager = new TransactionManager('sub-1', {
        saveFunction: neverSave,
        deleteFunction: deleteFn,
        retryDelayMs: 0,
        pauseDelayMs: 100_000,
      });

      localManager.startTransaction('content', makeLexical('hello'));
      localManager.settleTransaction(makeLexical('hello world'));
      // Don't await — transaction is still saving

      localManager.undo();
      await flushPromises();

      expect(deleteFn).not.toHaveBeenCalled();
      localManager.destroy();
    });

    it('emits transaction-undone event', async () => {
      const handler = jest.fn();
      manager.on('transaction-undone', handler);

      const tx = await createSettledTransaction(manager, 'hello', 'hello world');
      manager.undo();

      expect(handler).toHaveBeenCalledWith(tx);
    });

    it('provides beforeSnapshot with the pre-transaction state', async () => {
      const beforeState = makeLexical('original text');
      const tx = await createSettledTransaction(manager, 'original text', 'modified text');

      const undone = manager.undo();
      expect(undone).not.toBeNull();
      expect(undone!.beforeSnapshot.text).toBe('original text');
    });
  });

  // -----------------------------------------------------------------------
  // Transaction-level redo
  // -----------------------------------------------------------------------

  describe('redo', () => {
    it('returns null when redo stack is empty', () => {
      const result = manager.redo();
      expect(result).toBeNull();
    });

    it('returns null when no undo has been performed', async () => {
      await createSettledTransaction(manager, 'hello', 'hello world');
      const result = manager.redo();
      expect(result).toBeNull();
    });

    it('re-applies an undone transaction', async () => {
      const tx = await createSettledTransaction(manager, 'hello', 'hello world');
      manager.undo();

      const redone = manager.redo();
      expect(redone).toBe(tx);
      expect(manager.getUndoStack()).toHaveLength(1);
      expect(manager.getRedoStack()).toHaveLength(0);
    });

    it('re-triggers autosave for the redone transaction', async () => {
      await createSettledTransaction(manager, 'hello', 'hello world');
      const saveCallsBefore = saveFn.mock.calls.length;

      manager.undo();
      await flushPromises();

      manager.redo();
      await flushPromises();

      // Should have called save again for the redo
      expect(saveFn.mock.calls.length).toBeGreaterThan(saveCallsBefore);
    });

    it('emits transaction-redone event', async () => {
      const handler = jest.fn();
      manager.on('transaction-redone', handler);

      const tx = await createSettledTransaction(manager, 'hello', 'hello world');
      manager.undo();
      manager.redo();

      expect(handler).toHaveBeenCalledWith(tx);
    });

    it('provides afterSnapshot with the post-transaction state', async () => {
      await createSettledTransaction(manager, 'hello', 'hello world');
      manager.undo();

      const redone = manager.redo();
      expect(redone).not.toBeNull();
      expect(redone!.afterSnapshot).not.toBeNull();
      expect(redone!.afterSnapshot!.text).toBe('hello world');
    });
  });

  // -----------------------------------------------------------------------
  // Undo/redo stack interaction
  // -----------------------------------------------------------------------

  describe('undo/redo stack interaction', () => {
    it('starting a new transaction clears the redo stack', async () => {
      await createSettledTransaction(manager, 'hello', 'hello world');
      manager.undo();
      expect(manager.getRedoStack()).toHaveLength(1);

      // Starting a new transaction should clear redo
      manager.startTransaction('content', makeLexical('hello'));
      expect(manager.getRedoStack()).toHaveLength(0);
    });

    it('supports multiple sequential undo operations', async () => {
      const tx1 = await createSettledTransaction(manager, 'a', 'ab');
      const tx2 = await createSettledTransaction(manager, 'ab', 'abc');

      expect(manager.getUndoStack()).toHaveLength(2);

      const undone2 = manager.undo();
      expect(undone2).toBe(tx2);
      expect(manager.getUndoStack()).toHaveLength(1);

      const undone1 = manager.undo();
      expect(undone1).toBe(tx1);
      expect(manager.getUndoStack()).toHaveLength(0);
    });

    it('supports undo then redo then undo again', async () => {
      const tx = await createSettledTransaction(manager, 'hello', 'hello world');

      manager.undo();
      expect(manager.getUndoStack()).toHaveLength(0);
      expect(manager.getRedoStack()).toHaveLength(1);

      manager.redo();
      expect(manager.getUndoStack()).toHaveLength(1);
      expect(manager.getRedoStack()).toHaveLength(0);

      const undoneAgain = manager.undo();
      expect(undoneAgain).toBe(tx);
    });
  });

  // -----------------------------------------------------------------------
  // Plugin decision logic simulation
  // -----------------------------------------------------------------------

  describe('plugin decision logic', () => {
    /**
     * Simulates what the plugin does: if getActiveTransaction() is non-null,
     * return false (let Lexical handle it). Otherwise, call undo/redo.
     */
    function simulateUndoCommand(mgr: TransactionManager): { handled: boolean; transaction: Transaction | null } {
      if (mgr.getActiveTransaction() !== null) {
        return { handled: false, transaction: null };
      }
      const tx = mgr.undo();
      if (!tx) {
        return { handled: false, transaction: null };
      }
      return { handled: true, transaction: tx };
    }

    function simulateRedoCommand(mgr: TransactionManager): { handled: boolean; transaction: Transaction | null } {
      if (mgr.getActiveTransaction() !== null) {
        return { handled: false, transaction: null };
      }
      const tx = mgr.redo();
      if (!tx) {
        return { handled: false, transaction: null };
      }
      return { handled: true, transaction: tx };
    }

    it('delegates to Lexical when a transaction is active (undo)', () => {
      manager.startTransaction('content', makeLexical('hello'));
      const result = simulateUndoCommand(manager);
      expect(result.handled).toBe(false);
    });

    it('delegates to Lexical when a transaction is active (redo)', () => {
      manager.startTransaction('content', makeLexical('hello'));
      const result = simulateRedoCommand(manager);
      expect(result.handled).toBe(false);
    });

    it('handles undo at transaction level when idle with non-empty stack', async () => {
      await createSettledTransaction(manager, 'hello', 'hello world');
      const result = simulateUndoCommand(manager);
      expect(result.handled).toBe(true);
      expect(result.transaction).not.toBeNull();
    });

    it('handles redo at transaction level when idle with non-empty stack', async () => {
      await createSettledTransaction(manager, 'hello', 'hello world');
      manager.undo();
      const result = simulateRedoCommand(manager);
      expect(result.handled).toBe(true);
      expect(result.transaction).not.toBeNull();
    });

    it('falls through to Lexical when idle but stacks are empty (undo)', () => {
      const result = simulateUndoCommand(manager);
      expect(result.handled).toBe(false);
    });

    it('falls through to Lexical when idle but stacks are empty (redo)', () => {
      const result = simulateRedoCommand(manager);
      expect(result.handled).toBe(false);
    });
  });
});
