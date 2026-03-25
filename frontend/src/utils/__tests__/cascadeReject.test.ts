import { cascadeReject, CascadeRejectOptions } from '../cascadeReject';
import { TransactionManager, Transaction } from '../../services/transactionManager';
import { TrackedChangeResponse } from '../../services/trackedChangesService';

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

/** Stub save function that returns a fake TrackedChangeResponse. */
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

/** Create a TransactionManager with test defaults. */
function createTM(submissionId: string): TransactionManager {
  return new TransactionManager(submissionId, {
    saveFunction: makeSuccessSave(),
    deleteFunction: jest.fn(async () => {}),
    retryDelayMs: 0,
    pauseDelayMs: 1000000, // large to prevent auto-settle
  });
}

/** Wait for all pending microtasks / promises to resolve. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => process.nextTick(resolve));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cascadeReject', () => {
  let mockGetCascade: jest.Mock;
  let mockReject: jest.Mock;
  let mockRemoveDecorations: jest.Mock;
  let mockRefetch: jest.Mock;

  beforeEach(() => {
    mockGetCascade = jest.fn();
    mockReject = jest.fn(async () => {});
    mockRemoveDecorations = jest.fn();
    mockRefetch = jest.fn(async () => {});
  });

  function buildOptions(
    overrides: Partial<CascadeRejectOptions> = {},
  ): CascadeRejectOptions {
    return {
      submissionId: 'sub-1',
      changeId: 'change-1',
      getCascadeDependencies: mockGetCascade,
      rejectTrackedChange: mockReject,
      removeDecorations: mockRemoveDecorations,
      refetchSubmissionContent: mockRefetch,
      ...overrides,
    };
  }

  it('rejects a single change with no dependents', async () => {
    mockGetCascade.mockResolvedValue({ changeId: 'change-1', dependentIds: [] });

    const result = await cascadeReject(buildOptions());

    expect(result.removedChangeIds).toEqual(['change-1']);
    expect(result.failedDeleteIds).toEqual([]);

    // Should reject the one change
    expect(mockReject).toHaveBeenCalledTimes(1);
    expect(mockReject).toHaveBeenCalledWith('sub-1', 'change-1');

    // Should remove decorations for the one change
    expect(mockRemoveDecorations).toHaveBeenCalledTimes(1);
    expect(mockRemoveDecorations).toHaveBeenCalledWith('change-1');
  });

  it('rejects a chain of dependent changes in reverse order', async () => {
    mockGetCascade.mockResolvedValue({
      changeId: 'change-1',
      dependentIds: ['dep-a', 'dep-b', 'dep-c'],
    });

    const result = await cascadeReject(buildOptions());

    // Should process dependents newest first (reversed), then the original
    expect(result.removedChangeIds).toEqual(['dep-c', 'dep-b', 'dep-a', 'change-1']);
    expect(result.failedDeleteIds).toEqual([]);

    // Reject calls: 3 dependents + 1 original = 4
    expect(mockReject).toHaveBeenCalledTimes(4);

    // Verify order: dep-c, dep-b, dep-a, change-1
    expect(mockReject.mock.calls[0]).toEqual(['sub-1', 'dep-c']);
    expect(mockReject.mock.calls[1]).toEqual(['sub-1', 'dep-b']);
    expect(mockReject.mock.calls[2]).toEqual(['sub-1', 'dep-a']);
    expect(mockReject.mock.calls[3]).toEqual(['sub-1', 'change-1']);

    // Remove decorations: 3 dependents + 1 original = 4
    expect(mockRemoveDecorations).toHaveBeenCalledTimes(4);
  });

  it('continues on failed rejects (best effort)', async () => {
    mockGetCascade.mockResolvedValue({
      changeId: 'change-1',
      dependentIds: ['dep-a', 'dep-b'],
    });

    // Make dep-a fail (called second since we reverse: dep-b then dep-a)
    mockReject
      .mockResolvedValueOnce(undefined) // dep-b succeeds
      .mockRejectedValueOnce(new Error('Network error')) // dep-a fails
      .mockResolvedValueOnce(undefined); // change-1 succeeds

    const result = await cascadeReject(buildOptions());

    // All changes should still be in the removed list
    expect(result.removedChangeIds).toEqual(['dep-b', 'dep-a', 'change-1']);
    // dep-a should be in the failed list
    expect(result.failedDeleteIds).toEqual(['dep-a']);

    // All rejects should have been attempted
    expect(mockReject).toHaveBeenCalledTimes(3);

    // Decorations should still be removed for all
    expect(mockRemoveDecorations).toHaveBeenCalledTimes(3);
  });

  it('calls refetchSubmissionContent when provided', async () => {
    mockGetCascade.mockResolvedValue({ changeId: 'change-1', dependentIds: [] });

    const result = await cascadeReject(
      buildOptions({ transactionManager: null }),
    );

    expect(result.removedChangeIds).toEqual(['change-1']);
    // Should call refetch with the removed IDs
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('cleans up undo stack entries for removed changes', async () => {
    mockGetCascade.mockResolvedValue({
      changeId: 'change-1',
      dependentIds: ['dep-a'],
    });

    const tm = createTM('sub-1');

    // Create two transactions and settle them to populate the undo stack
    tm.startTransaction('content', makeLexical('hello'));
    tm.settleTransaction(makeLexical('hello world'));
    await flush();

    tm.startTransaction('content', makeLexical('hello world'));
    tm.settleTransaction(makeLexical('hello world foo'));
    await flush();

    const stack = tm.getUndoStack();
    expect(stack.length).toBe(2);

    // Simulate remote change IDs matching the cascade
    stack[0].remoteChangeId = 'change-1';
    stack[1].remoteChangeId = 'dep-a';

    await cascadeReject(
      buildOptions({ transactionManager: tm }),
    );

    // After cascade, the remoteChangeIds should be nulled out
    const updatedStack = tm.getUndoStack();
    for (const tx of updatedStack) {
      expect(tx.remoteChangeId).toBeNull();
    }
  });

  it('handles decoration removal failure gracefully', async () => {
    mockGetCascade.mockResolvedValue({
      changeId: 'change-1',
      dependentIds: ['dep-a'],
    });

    mockRemoveDecorations
      .mockImplementationOnce(() => { throw new Error('DOM error'); })
      .mockImplementationOnce(() => {});

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await cascadeReject(buildOptions());

    // Should still complete successfully
    expect(result.removedChangeIds).toEqual(['dep-a', 'change-1']);
    expect(result.failedDeleteIds).toEqual([]);

    consoleError.mockRestore();
  });

  it('does not mutate the original dependentIds array', async () => {
    const dependentIds = ['dep-a', 'dep-b', 'dep-c'];
    mockGetCascade.mockResolvedValue({
      changeId: 'change-1',
      dependentIds,
    });

    await cascadeReject(buildOptions());

    // Original array should be unchanged (we reverse a copy)
    expect(dependentIds).toEqual(['dep-a', 'dep-b', 'dep-c']);
  });
});
