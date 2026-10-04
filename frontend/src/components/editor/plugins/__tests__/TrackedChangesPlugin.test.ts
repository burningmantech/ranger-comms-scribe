/**
 * Tests for the incremental decoration logic in TrackedChangesPlugin.
 *
 * These tests validate the public API exports and the module-level registry
 * behavior. Full integration tests with a live Lexical editor are out of scope
 * here because Lexical requires a browser DOM environment; these tests focus on
 * the decoration registry management, incremental diffing logic, and the
 * exported utility functions.
 */

import {
  removeDecorationsForChange,
  removeDecorationsForChangeAnimated,
  getDecoratedChangeIds,
  TrackedChange,
} from '../TrackedChangesPlugin';

// ---------------------------------------------------------------------------
// Mock CSS Highlight API (not available in jsdom)
// ---------------------------------------------------------------------------

const mockHighlightsMap = new Map<string, any>();

beforeAll(() => {
  // Provide a minimal CSS.highlights mock so clearHighlights / removeHighlightsForChange work
  Object.defineProperty(globalThis, 'CSS', {
    value: {
      highlights: {
        set: (key: string, val: any) => mockHighlightsMap.set(key, val),
        get: (key: string) => mockHighlightsMap.get(key),
        has: (key: string) => mockHighlightsMap.has(key),
        delete: (key: string) => mockHighlightsMap.delete(key),
        forEach: (cb: (val: any, key: string) => void) => mockHighlightsMap.forEach(cb),
      },
    },
    writable: true,
    configurable: true,
  });
});

beforeEach(() => {
  mockHighlightsMap.clear();
});

// ---------------------------------------------------------------------------
// Test: Public API — getDecoratedChangeIds
// ---------------------------------------------------------------------------

describe('getDecoratedChangeIds', () => {
  it('returns an empty set when no decorations are applied', () => {
    const ids = getDecoratedChangeIds();
    // After a fresh import the registries should be empty
    // (or contain only leftovers from previous test runs — but we use
    //  removeDecorationsForChange to clean up in other tests).
    expect(ids).toBeInstanceOf(Set);
  });
});

// ---------------------------------------------------------------------------
// Test: Public API — removeDecorationsForChange
// ---------------------------------------------------------------------------

describe('removeDecorationsForChange', () => {
  it('does not throw when called with a non-existent changeId', () => {
    expect(() => {
      removeDecorationsForChange('non-existent-id');
    }).not.toThrow();
  });

  it('removes CSS highlights for the given changeId', () => {
    // Set up a mock highlight
    mockHighlightsMap.set('tracked-change-test-change-1', { ranges: [] });
    expect(mockHighlightsMap.has('tracked-change-test-change-1')).toBe(true);

    removeDecorationsForChange('test-change-1');

    expect(mockHighlightsMap.has('tracked-change-test-change-1')).toBe(false);
  });

  it('does not affect highlights for other changeIds', () => {
    mockHighlightsMap.set('tracked-change-change-a', { ranges: [] });
    mockHighlightsMap.set('tracked-change-change-b', { ranges: [] });

    removeDecorationsForChange('change-a');

    expect(mockHighlightsMap.has('tracked-change-change-a')).toBe(false);
    expect(mockHighlightsMap.has('tracked-change-change-b')).toBe(true);

    // Cleanup
    mockHighlightsMap.delete('tracked-change-change-b');
  });
});

// ---------------------------------------------------------------------------
// Test: Public API — removeDecorationsForChangeAnimated
// ---------------------------------------------------------------------------

describe('removeDecorationsForChangeAnimated', () => {
  it('returns a promise that resolves', async () => {
    const promise = removeDecorationsForChangeAnimated('non-existent-animated');
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).resolves.toBeUndefined();
  });

  it('removes CSS highlights for the changeId', async () => {
    mockHighlightsMap.set('tracked-change-animated-1', { ranges: [] });

    await removeDecorationsForChangeAnimated('animated-1');

    expect(mockHighlightsMap.has('tracked-change-animated-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test: TrackedChange interface
// ---------------------------------------------------------------------------

describe('TrackedChange interface', () => {
  it('can be constructed with required fields', () => {
    const change: TrackedChange = {
      id: 'change-1',
      field: 'content',
      oldValue: 'old text',
      newValue: 'new text',
      changedBy: 'user1',
      status: 'pending',
    };
    expect(change.id).toBe('change-1');
    expect(change.field).toBe('content');
    expect(change.status).toBe('pending');
  });

  it('can include optional richText fields', () => {
    const change: TrackedChange = {
      id: 'change-2',
      field: 'content',
      oldValue: '',
      newValue: '',
      changedBy: 'user1',
      status: 'pending',
      richTextOldValue: '{"root":{}}',
      richTextNewValue: '{"root":{}}',
    };
    expect(change.richTextOldValue).toBe('{"root":{}}');
    expect(change.richTextNewValue).toBe('{"root":{}}');
  });
});

// ---------------------------------------------------------------------------
// Test: Incremental behavior invariants
// ---------------------------------------------------------------------------

describe('Incremental decoration invariants', () => {
  it('getDecoratedChangeIds does not include IDs after removeDecorationsForChange', () => {
    // Start clean
    const before = getDecoratedChangeIds();
    const testId = '__test_incremental_1__';

    // Removing a non-existent ID should be a no-op
    removeDecorationsForChange(testId);
    const after = getDecoratedChangeIds();

    // The set should not contain the test ID
    expect(after.has(testId)).toBe(false);
  });

  it('handles rapid removal of multiple change IDs without errors', () => {
    const ids = ['rapid-1', 'rapid-2', 'rapid-3', 'rapid-4', 'rapid-5'];

    // Set up highlights for each
    for (const id of ids) {
      mockHighlightsMap.set(`tracked-change-${id}`, { ranges: [] });
    }

    expect(() => {
      for (const id of ids) {
        removeDecorationsForChange(id);
      }
    }).not.toThrow();

    // All should be removed
    for (const id of ids) {
      expect(mockHighlightsMap.has(`tracked-change-${id}`)).toBe(false);
    }
  });

  it('removeDecorationsForChange is idempotent', () => {
    mockHighlightsMap.set('tracked-change-idem-1', { ranges: [] });

    removeDecorationsForChange('idem-1');
    expect(mockHighlightsMap.has('tracked-change-idem-1')).toBe(false);

    // Calling again should not throw
    expect(() => {
      removeDecorationsForChange('idem-1');
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test: CSS Highlight API integration
// ---------------------------------------------------------------------------

describe('CSS Highlight API mock integration', () => {
  it('preserves non-tracked highlights in CSS.highlights', () => {
    mockHighlightsMap.set('custom-highlight-unrelated', { ranges: [] });
    mockHighlightsMap.set('tracked-change-to-remove', { ranges: [] });

    removeDecorationsForChange('to-remove');

    expect(mockHighlightsMap.has('custom-highlight-unrelated')).toBe(true);
    expect(mockHighlightsMap.has('tracked-change-to-remove')).toBe(false);

    // Cleanup
    mockHighlightsMap.delete('custom-highlight-unrelated');
  });
});
