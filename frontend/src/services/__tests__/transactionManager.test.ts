import {
  TransactionManager,
  Transaction,
  TransactionEvent,
  SaveStatus,
  RegionMap,
} from '../transactionManager';
import { TrackedChangeResponse } from '../trackedChangesService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Lexical JSON object whose extractTextFromLexical yields `text`. */
function makeLexical(text: string): object {
  const paragraphs = text.split('\n').map((line) => ({
    type: 'paragraph',
    children: [{ type: 'text', text: line }],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  }));
  return { root: { children: paragraphs, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } };
}

/** Stub that immediately resolves with a fake TrackedChangeResponse. */
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

/** Stub that fails N times then succeeds. */
function makeFailThenSuccessSave(failCount: number): jest.Mock {
  let calls = 0;
  return jest.fn(async (_sid: string, change: any) => {
    calls++;
    if (calls <= failCount) {
      throw new Error('Network error');
    }
    return {
      id: `remote-${calls}`,
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

/** Stub that always fails. */
function makeAlwaysFailSave(): jest.Mock {
  return jest.fn(async () => {
    throw new Error('Permanent network error');
  });
}

/** Stub delete function. */
function makeDeleteFn(): jest.Mock {
  return jest.fn(async () => {});
}

/** Create a TransactionManager with test defaults (zero retry delay). */
function createTM(
  submissionId: string,
  opts: {
    saveFunction?: jest.Mock;
    deleteFunction?: jest.Mock;
  } = {},
): TransactionManager {
  return new TransactionManager(submissionId, {
    saveFunction: opts.saveFunction ?? makeSuccessSave(),
    deleteFunction: opts.deleteFunction ?? makeDeleteFn(),
    retryDelayMs: 0,
  });
}

/**
 * Wait for all pending microtasks / promises to resolve.
 * We call this in a loop because chained .then()s need multiple ticks.
 */
async function flush(): Promise<void> {
  // Multiple rounds to let chained promise callbacks execute
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransactionManager', () => {
  // -----------------------------------------------------------------------
  // Construction & initial state
  // -----------------------------------------------------------------------

  describe('initial state', () => {
    it('has no active transaction', () => {
      const tm = createTM('sub-1');
      expect(tm.getActiveTransaction()).toBeNull();
    });

    it('has empty undo stack', () => {
      const tm = createTM('sub-1');
      expect(tm.getUndoStack()).toEqual([]);
    });

    it('reports all-saved status', () => {
      const tm = createTM('sub-1');
      expect(tm.getSaveStatus()).toBe('all-saved');
    });
  });

  // -----------------------------------------------------------------------
  // startTransaction
  // -----------------------------------------------------------------------

  describe('startTransaction', () => {
    it('creates an active transaction with a before snapshot', () => {
      const tm = createTM('sub-1');

      const lexical = makeLexical('Hello world');
      const tx = tm.startTransaction('content', lexical);

      expect(tx.status).toBe('active');
      expect(tx.field).toBe('content');
      expect(tx.beforeSnapshot.text).toBe('Hello world');
      expect(tx.afterSnapshot).toBeNull();
      expect(tx.regionMap).toBeNull();
      expect(tm.getActiveTransaction()).toBe(tx);
    });

    it('clears the redo stack', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });

      // Create and settle a transaction, then undo it to populate redo stack
      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      await flush();

      tm.undo();
      expect(tm.getRedoStack().length).toBe(1);

      // Starting a new transaction should clear the redo stack
      tm.startTransaction('content', makeLexical('B'));
      expect(tm.getRedoStack().length).toBe(0);
    });

    it('auto-settles the previous active transaction if one exists', () => {
      const tm = createTM('sub-1');

      const tx1 = tm.startTransaction('content', makeLexical('First'));
      // Start a second transaction without settling the first
      const tx2 = tm.startTransaction('content', makeLexical('Second'));

      // The first transaction should have been auto-settled
      expect(tx1.status).not.toBe('active');
      expect(tm.getActiveTransaction()).toBe(tx2);
    });
  });

  // -----------------------------------------------------------------------
  // settleTransaction
  // -----------------------------------------------------------------------

  describe('settleTransaction', () => {
    it('transitions transaction to settled and computes afterSnapshot + regionMap', () => {
      const tm = createTM('sub-1');

      tm.startTransaction('content', makeLexical('Hello'));
      const tx = tm.settleTransaction(makeLexical('Hello world'))!;

      expect(tx).not.toBeNull();
      expect(tx.status).toBe('settled');
      expect(tx.afterSnapshot!.text).toBe('Hello world');
      expect(tx.regionMap).not.toBeNull();
      expect(tx.regionMap!.field).toBe('content');
      expect(tx.regionMap!.ranges.length).toBeGreaterThan(0);
      expect(tx.settledAt).not.toBeNull();
    });

    it('returns null if there is no active transaction', () => {
      const tm = createTM('sub-1');
      expect(tm.settleTransaction(makeLexical('whatever'))).toBeNull();
    });

    it('emits transaction-settled event', () => {
      const tm = createTM('sub-1');
      const handler = jest.fn();
      tm.on('transaction-settled', handler);

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].field).toBe('content');
    });

    it('pushes the transaction onto the undo stack', () => {
      const tm = createTM('sub-1');

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      const stack = tm.getUndoStack();
      expect(stack.length).toBe(1);
      expect(stack[0].field).toBe('content');
    });

    it('clears the active transaction after settling', () => {
      const tm = createTM('sub-1');

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      expect(tm.getActiveTransaction()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Region map computation
  // -----------------------------------------------------------------------

  describe('region map computation', () => {
    it('computes insertion ranges correctly', () => {
      const tm = createTM('sub-1');

      tm.startTransaction('content', makeLexical('Hello'));
      const tx = tm.settleTransaction(makeLexical('Hello world'))!;

      // "Hello" -> "Hello world" means " world" was inserted at position 5
      expect(tx.regionMap!.ranges.length).toBe(1);
      expect(tx.regionMap!.ranges[0].start).toBe(5);
      expect(tx.regionMap!.ranges[0].end).toBe(11);
    });

    it('computes deletion ranges (zero-width) correctly', () => {
      const tm = createTM('sub-1');

      tm.startTransaction('content', makeLexical('Hello world'));
      const tx = tm.settleTransaction(makeLexical('Hello'))!;

      // " world" was deleted — zero-width range at position 5 in the new text
      expect(tx.regionMap!.ranges.length).toBe(1);
      expect(tx.regionMap!.ranges[0].start).toBe(5);
      expect(tx.regionMap!.ranges[0].end).toBe(5);
    });

    it('handles replacement (delete + insert)', () => {
      const tm = createTM('sub-1');

      tm.startTransaction('content', makeLexical('Hello world'));
      const tx = tm.settleTransaction(makeLexical('Hello earth'))!;

      expect(tx.regionMap!.ranges.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty ranges when content is unchanged', () => {
      const tm = createTM('sub-1');

      tm.startTransaction('content', makeLexical('Same'));
      const tx = tm.settleTransaction(makeLexical('Same'))!;

      expect(tx.regionMap!.ranges).toEqual([]);
    });

    it('merges adjacent/overlapping ranges', () => {
      const tm = createTM('sub-1');

      // "abcdef" -> "aXYZef" means chars at positions 1-3 were replaced
      tm.startTransaction('content', makeLexical('abcdef'));
      const tx = tm.settleTransaction(makeLexical('aXYZef'))!;

      // Should have merged ranges rather than separate per-char ranges
      expect(tx.regionMap!.ranges.length).toBeGreaterThanOrEqual(1);
      // All affected ranges should be contiguous or merged
      for (let i = 1; i < tx.regionMap!.ranges.length; i++) {
        expect(tx.regionMap!.ranges[i].start).toBeGreaterThanOrEqual(
          tx.regionMap!.ranges[i - 1].end,
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // Autosave coordination
  // -----------------------------------------------------------------------

  describe('autosave', () => {
    it('saves successfully and transitions to saved status', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const savedHandler = jest.fn();
      tm.on('transaction-saved', savedHandler);

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      await flush();

      expect(saveFn).toHaveBeenCalledTimes(1);
      expect(savedHandler).toHaveBeenCalledTimes(1);
      const tx = savedHandler.mock.calls[0][0] as Transaction;
      expect(tx.status).toBe('saved');
      expect(tx.remoteChangeId).toBeTruthy();
      expect(tm.getSaveStatus()).toBe('all-saved');
    });

    it('does not save when before and after text are identical', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });

      tm.startTransaction('content', makeLexical('Same'));
      tm.settleTransaction(makeLexical('Same'));

      await flush();

      expect(saveFn).not.toHaveBeenCalled();
    });

    it('retries once on failure and succeeds', async () => {
      const saveFn = makeFailThenSuccessSave(1);
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const savedHandler = jest.fn();
      const errorHandler = jest.fn();
      tm.on('transaction-saved', savedHandler);
      tm.on('save-error', errorHandler);

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      await flush();

      expect(saveFn).toHaveBeenCalledTimes(2);
      expect(savedHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler).not.toHaveBeenCalled();
      expect(tm.getSaveStatus()).toBe('all-saved');
    });

    it('marks as failed after retry failure', async () => {
      const saveFn = makeAlwaysFailSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const errorHandler = jest.fn();
      tm.on('save-error', errorHandler);

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      await flush();

      expect(saveFn).toHaveBeenCalledTimes(2); // initial + 1 retry
      expect(errorHandler).toHaveBeenCalledTimes(1);
      const tx = errorHandler.mock.calls[0][0] as Transaction;
      expect(tx.status).toBe('failed');
      expect(tm.getSaveStatus()).toBe('error');
    });

    it('emits save-status-changed events during save lifecycle', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const statuses: SaveStatus[] = [];
      tm.on('save-status-changed', (s: SaveStatus) => statuses.push(s));

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      await flush();

      // Should have gone: saving -> all-saved
      expect(statuses).toContain('saving');
      expect(statuses[statuses.length - 1]).toBe('all-saved');
    });

    it('calls save function with correct arguments', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });

      tm.startTransaction('content', makeLexical('Hello'));
      tm.settleTransaction(makeLexical('Hello world'));
      await flush();

      expect(saveFn).toHaveBeenCalledTimes(1);
      const callArgs = saveFn.mock.calls[0];
      expect(callArgs[0]).toBe('sub-1');
      expect(callArgs[1].field).toBe('content');
      expect(callArgs[1].oldValue).toBe('Hello');
      expect(callArgs[1].newValue).toBe('Hello world');
      expect(callArgs[1].regionMap).toBeDefined();
      expect(callArgs[1].regionMap.field).toBe('content');
      expect(callArgs[1].regionMap.ranges.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Undo / Redo
  // -----------------------------------------------------------------------

  describe('undo', () => {
    it('returns the most recent transaction and moves it to redo stack', async () => {
      const saveFn = makeSuccessSave();
      const deleteFn = makeDeleteFn();
      const tm = createTM('sub-1', { saveFunction: saveFn, deleteFunction: deleteFn });

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      await flush();

      const undone = tm.undo();
      expect(undone).not.toBeNull();
      expect(undone!.beforeSnapshot.text).toBe('A');
      expect(undone!.afterSnapshot!.text).toBe('B');

      expect(tm.getUndoStack().length).toBe(0);
      expect(tm.getRedoStack().length).toBe(1);
    });

    it('returns null when undo stack is empty', () => {
      const tm = createTM('sub-1');
      expect(tm.undo()).toBeNull();
    });

    it('emits transaction-undone event', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const handler = jest.fn();
      tm.on('transaction-undone', handler);

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      await flush();

      tm.undo();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('triggers remote delete when the transaction was saved', async () => {
      const saveFn = makeSuccessSave();
      const deleteFn = makeDeleteFn();
      const tm = createTM('sub-1', { saveFunction: saveFn, deleteFunction: deleteFn });

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      await flush();

      const tx = tm.peekTransaction()!;
      const remoteId = tx.remoteChangeId;
      expect(remoteId).toBeTruthy();

      tm.undo();
      await flush();

      expect(deleteFn).toHaveBeenCalledWith('sub-1', remoteId);
    });

    it('does not trigger remote delete for unsaved transactions', async () => {
      const saveFn = makeAlwaysFailSave();
      const deleteFn = makeDeleteFn();
      const tm = createTM('sub-1', { saveFunction: saveFn, deleteFunction: deleteFn });

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      await flush();

      tm.undo();
      await flush();

      expect(deleteFn).not.toHaveBeenCalled();
    });
  });

  describe('redo', () => {
    it('returns the most recently undone transaction and moves it back to undo stack', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      await flush();

      tm.undo();
      expect(tm.getRedoStack().length).toBe(1);

      const redone = tm.redo();
      expect(redone).not.toBeNull();
      expect(redone!.afterSnapshot!.text).toBe('B');

      expect(tm.getUndoStack().length).toBe(1);
      expect(tm.getRedoStack().length).toBe(0);
    });

    it('returns null when redo stack is empty', () => {
      const tm = createTM('sub-1');
      expect(tm.redo()).toBeNull();
    });

    it('emits transaction-redone event', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const handler = jest.fn();
      tm.on('transaction-redone', handler);

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      await flush();

      tm.undo();
      tm.redo();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('triggers autosave on redo', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      await flush();

      // saveFn called once for initial save
      expect(saveFn).toHaveBeenCalledTimes(1);

      tm.undo();
      tm.redo();
      await flush();

      // saveFn called again for redo autosave
      expect(saveFn).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // peekTransaction
  // -----------------------------------------------------------------------

  describe('peekTransaction', () => {
    it('returns the top of undo stack without removing it', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      await flush();

      const peeked = tm.peekTransaction();
      expect(peeked).not.toBeNull();
      expect(peeked!.afterSnapshot!.text).toBe('B');

      // Stack should still have 1 item
      expect(tm.getUndoStack().length).toBe(1);
    });

    it('returns null on empty stack', () => {
      const tm = createTM('sub-1');
      expect(tm.peekTransaction()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Max undo depth
  // -----------------------------------------------------------------------

  describe('max undo depth', () => {
    it('limits undo stack to 50 transactions', () => {
      const tm = createTM('sub-1');

      for (let i = 0; i < 60; i++) {
        tm.startTransaction('content', makeLexical(`v${i}`));
        tm.settleTransaction(makeLexical(`v${i + 1}`));
      }

      expect(tm.getUndoStack().length).toBe(50);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple transactions
  // -----------------------------------------------------------------------

  describe('multiple transactions', () => {
    it('maintains correct order in undo stack', () => {
      const tm = createTM('sub-1');

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      tm.startTransaction('content', makeLexical('B'));
      tm.settleTransaction(makeLexical('C'));

      tm.startTransaction('content', makeLexical('C'));
      tm.settleTransaction(makeLexical('D'));

      const stack = tm.getUndoStack();
      expect(stack.length).toBe(3);
      expect(stack[0].beforeSnapshot.text).toBe('A');
      expect(stack[1].beforeSnapshot.text).toBe('B');
      expect(stack[2].beforeSnapshot.text).toBe('C');
    });

    it('undo/redo sequence works correctly', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      tm.startTransaction('content', makeLexical('B'));
      tm.settleTransaction(makeLexical('C'));
      await flush();

      // Undo twice
      const u1 = tm.undo()!;
      expect(u1.afterSnapshot!.text).toBe('C');
      const u2 = tm.undo()!;
      expect(u2.afterSnapshot!.text).toBe('B');

      expect(tm.getUndoStack().length).toBe(0);
      expect(tm.getRedoStack().length).toBe(2);

      // Redo once
      const r1 = tm.redo()!;
      expect(r1.afterSnapshot!.text).toBe('B');
      expect(tm.getUndoStack().length).toBe(1);
      expect(tm.getRedoStack().length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // EventEmitter
  // -----------------------------------------------------------------------

  describe('event emitter', () => {
    it('supports on/off for event listeners', () => {
      const tm = createTM('sub-1');
      const handler = jest.fn();

      tm.on('transaction-settled', handler);
      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      expect(handler).toHaveBeenCalledTimes(1);

      // Remove listener
      tm.off('transaction-settled', handler);
      tm.startTransaction('content', makeLexical('B'));
      tm.settleTransaction(makeLexical('C'));

      // Should still be 1 call
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('multiple listeners receive events', () => {
      const tm = createTM('sub-1');
      const h1 = jest.fn();
      const h2 = jest.fn();

      tm.on('transaction-settled', h1);
      tm.on('transaction-settled', h2);

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('handler errors do not break other handlers', () => {
      const tm = createTM('sub-1');
      const bad = jest.fn(() => { throw new Error('oops'); });
      const good = jest.fn();

      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

      tm.on('transaction-settled', bad);
      tm.on('transaction-settled', good);

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      expect(bad).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledTimes(1);

      spy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // getSaveStatus
  // -----------------------------------------------------------------------

  describe('getSaveStatus', () => {
    it('returns saving while a save is in-flight', async () => {
      let resolveSave!: (val: TrackedChangeResponse) => void;
      const saveFn = jest.fn(() => new Promise<TrackedChangeResponse>((resolve) => {
        resolveSave = resolve;
      }));
      const tm = new TransactionManager('sub-1', {
        saveFunction: saveFn,
        deleteFunction: makeDeleteFn(),
        retryDelayMs: 0,
      });

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      // Let the autosave microtask begin (the save promise is now pending)
      await flush();

      expect(tm.getSaveStatus()).toBe('saving');

      // Now resolve
      resolveSave({
        id: 'r-1',
        submissionId: 'sub-1',
        field: 'content',
        oldValue: 'A',
        newValue: 'B',
        changedBy: 'u1',
        changedByName: 'U1',
        timestamp: new Date().toISOString(),
        status: 'pending',
        comments: [],
      });

      await flush();
      expect(tm.getSaveStatus()).toBe('all-saved');
    });
  });

  // -----------------------------------------------------------------------
  // destroy
  // -----------------------------------------------------------------------

  describe('destroy', () => {
    it('clears all state and listeners', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const handler = jest.fn();
      tm.on('transaction-settled', handler);

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      await flush();

      tm.destroy();

      expect(tm.getActiveTransaction()).toBeNull();
      expect(tm.getUndoStack()).toEqual([]);
      expect(tm.getRedoStack()).toEqual([]);
      expect(tm.getSaveStatus()).toBe('all-saved');

      // Listeners should be cleared
      tm.startTransaction('content', makeLexical('X'));
      tm.settleTransaction(makeLexical('Y'));
      expect(handler).toHaveBeenCalledTimes(1); // Only the original call
    });
  });

  // -----------------------------------------------------------------------
  // Field tracking
  // -----------------------------------------------------------------------

  describe('field tracking', () => {
    it('tracks different fields correctly', () => {
      const tm = createTM('sub-1');

      tm.startTransaction('title', makeLexical('Old Title'));
      tm.settleTransaction(makeLexical('New Title'));

      tm.startTransaction('content', makeLexical('Old Content'));
      tm.settleTransaction(makeLexical('New Content'));

      const stack = tm.getUndoStack();
      expect(stack[0].field).toBe('title');
      expect(stack[1].field).toBe('content');
      expect(stack[0].regionMap!.field).toBe('title');
      expect(stack[1].regionMap!.field).toBe('content');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty text before and after', () => {
      const tm = createTM('sub-1');

      const emptyLexical = { root: { children: [], direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } };
      tm.startTransaction('content', emptyLexical);
      const tx = tm.settleTransaction(emptyLexical)!;

      expect(tx).not.toBeNull();
      expect(tx.regionMap!.ranges).toEqual([]);
    });

    it('handles settling with text added to empty document', () => {
      const tm = createTM('sub-1');

      const emptyLexical = { root: { children: [], direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } };
      tm.startTransaction('content', emptyLexical);
      const tx = tm.settleTransaction(makeLexical('New content'))!;

      expect(tx.regionMap!.ranges.length).toBeGreaterThan(0);
      expect(tx.beforeSnapshot.text).toBe('');
      expect(tx.afterSnapshot!.text).toBe('New content');
    });

    it('transaction IDs are unique', () => {
      const tm = createTM('sub-1');

      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const tx = tm.startTransaction('content', makeLexical(`v${i}`));
        ids.add(tx.id);
        tm.settleTransaction(makeLexical(`v${i + 1}`));
      }

      expect(ids.size).toBe(20);
    });

    it('getUndoStack returns a copy, not a reference', () => {
      const tm = createTM('sub-1');

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));

      const stack1 = tm.getUndoStack();
      const stack2 = tm.getUndoStack();

      expect(stack1).not.toBe(stack2);
      expect(stack1).toEqual(stack2);
    });

    it('getRedoStack returns a copy, not a reference', async () => {
      const tm = createTM('sub-1');

      tm.startTransaction('content', makeLexical('A'));
      tm.settleTransaction(makeLexical('B'));
      tm.undo();

      const stack1 = tm.getRedoStack();
      const stack2 = tm.getRedoStack();

      expect(stack1).not.toBe(stack2);
      expect(stack1).toEqual(stack2);
    });
  });
});
