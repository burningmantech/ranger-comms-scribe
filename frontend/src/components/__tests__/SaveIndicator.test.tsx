import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import SaveIndicator, { orphanedKey, OrphanedTransaction } from '../SaveIndicator';
import { TransactionManager, SaveStatus, Transaction } from '../../services/transactionManager';
import { TrackedChangeResponse } from '../../services/trackedChangesService';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockBatchCreate = jest.fn();
jest.mock('../../services/trackedChangesService', () => ({
  trackedChangesService: {
    batchCreate: (...args: any[]) => mockBatchCreate(...args),
  },
}));

jest.mock('../../config', () => ({
  API_URL: 'http://test-api',
}));

// ---------------------------------------------------------------------------
// Helpers
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
  return { root: { children: paragraphs, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } };
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

function makeAlwaysFailSave(): jest.Mock {
  return jest.fn(async () => {
    throw new Error('Network error');
  });
}

function makeDeleteFn(): jest.Mock {
  return jest.fn(async () => {});
}

function createTM(
  submissionId: string,
  opts: { saveFunction?: jest.Mock; deleteFunction?: jest.Mock } = {},
): TransactionManager {
  return new TransactionManager(submissionId, {
    saveFunction: opts.saveFunction ?? makeSuccessSave(),
    deleteFunction: opts.deleteFunction ?? makeDeleteFn(),
    retryDelayMs: 0,
    pauseDelayMs: 100000,
  });
}

/**
 * Flush microtasks and advance fake timers so that:
 * - Promise chains resolve (microtasks)
 * - Any setTimeout(fn, 0) from retry delay fires
 *
 * We interleave timer advancement and microtask flushing
 * to handle the chained async logic in TransactionManager.
 */
async function flushAll(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    // Flush microtasks
    await Promise.resolve();
    // Advance any pending timers (including setTimeout(fn, 0) from retry delay)
    jest.advanceTimersByTime(0);
  }
  // One more round of microtask flushing
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SaveIndicator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockBatchCreate.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Visual states
  // -----------------------------------------------------------------------

  describe('visual states', () => {
    it('renders in saved state by default', () => {
      const tm = createTM('sub-1');
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      const indicator = screen.getByRole('status');
      expect(indicator).toHaveClass('save-indicator--saved');
      expect(indicator).toHaveAttribute('aria-label', 'All changes saved');
      tm.destroy();
    });

    it('transitions to saving state when TransactionManager emits saving', () => {
      const saveFn = jest.fn(() => new Promise<TrackedChangeResponse>(() => {})); // Never resolves
      const tm = createTM('sub-1', { saveFunction: saveFn });
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      act(() => {
        tm.startTransaction('content', makeLexical('before'));
        tm.settleTransaction(makeLexical('after'));
      });

      const indicator = screen.getByRole('status');
      expect(indicator).toHaveClass('save-indicator--saving');
      expect(indicator).toHaveAttribute('aria-label', 'Saving changes');
      tm.destroy();
    });

    it('transitions to just-saved then back to saved after 2 seconds', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      // Trigger save
      act(() => {
        tm.startTransaction('content', makeLexical('before'));
        tm.settleTransaction(makeLexical('after'));
      });

      // Flush async save
      await act(async () => {
        await flushAll();
      });

      const indicator = screen.getByRole('status');
      expect(indicator).toHaveClass('save-indicator--just-saved');
      expect(indicator).toHaveAttribute('aria-label', 'Changes saved');

      // After 2 seconds, should be back to saved
      act(() => {
        jest.advanceTimersByTime(2000);
      });

      expect(indicator).toHaveClass('save-indicator--saved');
      tm.destroy();
    });

    it('transitions to error state on save failure', async () => {
      const saveFn = makeAlwaysFailSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      act(() => {
        tm.startTransaction('content', makeLexical('before'));
        tm.settleTransaction(makeLexical('after'));
      });

      // Flush save + retry
      await act(async () => {
        await flushAll();
      });

      const indicator = screen.getByRole('status');
      expect(indicator).toHaveClass('save-indicator--error');
      expect(indicator).toHaveAttribute('aria-label', 'Save failed');
      tm.destroy();
    });

    it('renders warning dot only in error state', async () => {
      const saveFn = makeAlwaysFailSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const { container } = render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      // Initially no warning dot
      expect(container.querySelector('.save-indicator__warning-dot')).not.toBeInTheDocument();

      act(() => {
        tm.startTransaction('content', makeLexical('before'));
        tm.settleTransaction(makeLexical('after'));
      });
      await act(async () => {
        await flushAll();
      });

      expect(container.querySelector('.save-indicator__warning-dot')).toBeInTheDocument();
      tm.destroy();
    });

    it('renders checkmark only in just-saved state', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const { container } = render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      expect(container.querySelector('.save-indicator__check')).not.toBeInTheDocument();

      act(() => {
        tm.startTransaction('content', makeLexical('before'));
        tm.settleTransaction(makeLexical('after'));
      });
      await act(async () => {
        await flushAll();
      });

      expect(container.querySelector('.save-indicator__check')).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(2000);
      });

      expect(container.querySelector('.save-indicator__check')).not.toBeInTheDocument();
      tm.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // beforeunload — save-on-close
  // -----------------------------------------------------------------------

  describe('beforeunload / save-on-close', () => {
    it('persists unsaved transactions to localStorage on beforeunload', () => {
      const saveFn = jest.fn(() => new Promise<TrackedChangeResponse>(() => {})); // Never resolves
      const tm = createTM('sub-1', { saveFunction: saveFn });
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      act(() => {
        tm.startTransaction('content', makeLexical('before'));
        tm.settleTransaction(makeLexical('after'));
      });

      act(() => {
        window.dispatchEvent(new Event('beforeunload'));
      });

      const stored = localStorage.getItem(orphanedKey('sub-1'));
      expect(stored).not.toBeNull();

      const orphans: OrphanedTransaction[] = JSON.parse(stored!);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].field).toBe('content');
      expect(orphans[0].oldValue).toBe('before');
      expect(orphans[0].newValue).toBe('after');
      tm.destroy();
    });

    it('settles active transaction before persisting on beforeunload', () => {
      const saveFn = jest.fn(() => new Promise<TrackedChangeResponse>(() => {}));
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const getLatest = () => makeLexical('latest-state');

      render(
        <SaveIndicator
          transactionManager={tm}
          submissionId="sub-1"
          getLatestEditorState={getLatest}
        />,
      );

      act(() => {
        tm.startTransaction('content', makeLexical('before'));
      });

      expect(tm.getActiveTransaction()).not.toBeNull();

      act(() => {
        window.dispatchEvent(new Event('beforeunload'));
      });

      expect(tm.getActiveTransaction()).toBeNull();

      const stored = localStorage.getItem(orphanedKey('sub-1'));
      expect(stored).not.toBeNull();

      const orphans: OrphanedTransaction[] = JSON.parse(stored!);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].newValue).toBe('latest-state');
      tm.destroy();
    });

    it('does not persist when all transactions are saved', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      act(() => {
        tm.startTransaction('content', makeLexical('before'));
        tm.settleTransaction(makeLexical('after'));
      });
      await act(async () => {
        await flushAll();
      });

      act(() => {
        window.dispatchEvent(new Event('beforeunload'));
      });

      const stored = localStorage.getItem(orphanedKey('sub-1'));
      if (stored) {
        expect(JSON.parse(stored)).toHaveLength(0);
      }
      tm.destroy();
    });

    it('merges with existing orphans in localStorage', async () => {
      const existing: OrphanedTransaction[] = [{
        field: 'title',
        oldValue: 'old title',
        newValue: 'new title',
        settledAt: Date.now() - 10000,
      }];
      localStorage.setItem(orphanedKey('sub-1'), JSON.stringify(existing));

      // Mock batchCreate to fail so orphans stay in localStorage
      mockBatchCreate.mockRejectedValueOnce(new Error('fail'));

      const saveFn = jest.fn(() => new Promise<TrackedChangeResponse>(() => {}));
      const tm = createTM('sub-1', { saveFunction: saveFn });
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      // Flush orphan recovery attempt (it will fail)
      await act(async () => {
        await flushAll();
      });

      // Add another unsaved transaction
      act(() => {
        tm.startTransaction('content', makeLexical('before'));
        tm.settleTransaction(makeLexical('after'));
      });

      act(() => {
        window.dispatchEvent(new Event('beforeunload'));
      });

      const stored = localStorage.getItem(orphanedKey('sub-1'));
      expect(stored).not.toBeNull();

      const orphans: OrphanedTransaction[] = JSON.parse(stored!);
      expect(orphans.length).toBeGreaterThanOrEqual(2);
      tm.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // Orphaned transaction recovery
  // -----------------------------------------------------------------------

  describe('orphaned transaction recovery', () => {
    it('recovers orphaned transactions from localStorage on mount', async () => {
      const orphans: OrphanedTransaction[] = [
        { field: 'content', oldValue: 'old text', newValue: 'new text', settledAt: Date.now() },
        { field: 'title', oldValue: 'old title', newValue: 'new title', settledAt: Date.now() },
      ];
      localStorage.setItem(orphanedKey('sub-1'), JSON.stringify(orphans));

      mockBatchCreate.mockResolvedValueOnce([]);

      const tm = createTM('sub-1');
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      await act(async () => {
        await flushAll();
      });

      expect(mockBatchCreate).toHaveBeenCalledWith('sub-1', [
        { field: 'content', oldValue: 'old text', newValue: 'new text', regionMap: undefined },
        { field: 'title', oldValue: 'old title', newValue: 'new title', regionMap: undefined },
      ]);

      expect(localStorage.getItem(orphanedKey('sub-1'))).toBeNull();
      tm.destroy();
    });

    it('keeps orphans in localStorage when recovery fails', async () => {
      const orphans: OrphanedTransaction[] = [
        { field: 'content', oldValue: 'old text', newValue: 'new text', settledAt: Date.now() },
      ];
      localStorage.setItem(orphanedKey('sub-1'), JSON.stringify(orphans));

      mockBatchCreate.mockRejectedValueOnce(new Error('Server down'));

      const tm = createTM('sub-1');
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      await act(async () => {
        await flushAll();
      });

      const stored = localStorage.getItem(orphanedKey('sub-1'));
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toHaveLength(1);
      tm.destroy();
    });

    it('cleans up corrupt localStorage data', async () => {
      localStorage.setItem(orphanedKey('sub-1'), 'not-valid-json{{{');

      const tm = createTM('sub-1');
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      await act(async () => {
        await flushAll();
      });

      expect(localStorage.getItem(orphanedKey('sub-1'))).toBeNull();
      expect(mockBatchCreate).not.toHaveBeenCalled();
      tm.destroy();
    });

    it('handles empty orphan array gracefully', async () => {
      localStorage.setItem(orphanedKey('sub-1'), JSON.stringify([]));

      const tm = createTM('sub-1');
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      await act(async () => {
        await flushAll();
      });

      expect(localStorage.getItem(orphanedKey('sub-1'))).toBeNull();
      expect(mockBatchCreate).not.toHaveBeenCalled();
      tm.destroy();
    });

    it('does nothing when no orphans exist', async () => {
      const tm = createTM('sub-1');
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      await act(async () => {
        await flushAll();
      });

      expect(mockBatchCreate).not.toHaveBeenCalled();
      tm.destroy();
    });

    it('preserves regionMap in orphaned transactions', async () => {
      const orphans: OrphanedTransaction[] = [
        {
          field: 'content',
          oldValue: 'hello',
          newValue: 'hello world',
          regionMap: { field: 'content', ranges: [{ start: 5, end: 11 }] },
          settledAt: Date.now(),
        },
      ];
      localStorage.setItem(orphanedKey('sub-1'), JSON.stringify(orphans));

      mockBatchCreate.mockResolvedValueOnce([]);

      const tm = createTM('sub-1');
      render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      await act(async () => {
        await flushAll();
      });

      expect(mockBatchCreate).toHaveBeenCalledWith('sub-1', [
        {
          field: 'content',
          oldValue: 'hello',
          newValue: 'hello world',
          regionMap: { field: 'content', ranges: [{ start: 5, end: 11 }] },
        },
      ]);
      tm.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // orphanedKey helper
  // -----------------------------------------------------------------------

  describe('orphanedKey', () => {
    it('returns correct localStorage key format', () => {
      expect(orphanedKey('abc-123')).toBe('tce-orphaned-abc-123');
      expect(orphanedKey('sub_xyz')).toBe('tce-orphaned-sub_xyz');
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  describe('cleanup', () => {
    it('removes event listener on unmount', () => {
      const tm = createTM('sub-1');
      const { unmount } = render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      unmount();

      // After unmount, start+settle a transaction so the undo stack has unsaved entries
      tm.startTransaction('content', makeLexical('before'));
      tm.settleTransaction(makeLexical('after'));

      window.dispatchEvent(new Event('beforeunload'));

      // No orphans should be written because the listener was removed
      expect(localStorage.getItem(orphanedKey('sub-1'))).toBeNull();
      tm.destroy();
    });

    it('clears just-saved timer on unmount', async () => {
      const saveFn = makeSuccessSave();
      const tm = createTM('sub-1', { saveFunction: saveFn });
      const { unmount } = render(
        <SaveIndicator transactionManager={tm} submissionId="sub-1" />,
      );

      act(() => {
        tm.startTransaction('content', makeLexical('before'));
        tm.settleTransaction(makeLexical('after'));
      });
      await act(async () => {
        await flushAll();
      });

      unmount();

      // Advancing timers should not cause errors (timer was cleaned up)
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      tm.destroy();
    });
  });
});
