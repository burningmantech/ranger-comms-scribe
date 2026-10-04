import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { undoChange, deleteChange, getCascadeDependencies, batchCreateTrackedChanges, createTrackedChange, TrackedChange, calculateIncrementalChange, RegionMap } from '../../src/services/trackedChangesService';
import { createCacheServiceMock } from './cache-mock-helpers';

describe('trackedChangesService', () => {
  let mockEnv: any;

  beforeEach(() => {
    const cacheMocks = createCacheServiceMock();
    mockEnv = {
      R2: {
        list: jest.fn(),
        get: jest.fn(),
        put: jest.fn(),
        delete: jest.fn()
      },
      CACHE: cacheMocks.cache
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('undoChange', () => {
    it('should successfully undo an approved change', async () => {
      const changeId = 'test-change-id';
      const submissionId = 'test-submission-id';
      
      // Mock a change that is currently approved
      const mockChange: TrackedChange = {
        id: changeId,
        submissionId,
        field: 'content',
        oldValue: 'old content',
        newValue: 'new content',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: new Date().toISOString(),
        status: 'approved',
        approvedBy: 'user2',
        approvedByName: 'User Two',
        approvedAt: new Date().toISOString()
      };

      // Mock the listObjects to return our change
      mockEnv.R2.list = jest.fn().mockResolvedValue({
        objects: [{ key: `tracked-changes/submission/${submissionId}/${changeId}` }]
      });

      // Mock getObject to return our change
      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange)
      });

      // Mock putObject to simulate saving
      mockEnv.R2.put = jest.fn().mockResolvedValue(undefined);

      const result = await undoChange(submissionId, changeId, mockEnv);

      expect(result).not.toBeNull();
      expect(result?.status).toBe('pending');
      expect(result?.approvedBy).toBeUndefined();
      expect(result?.approvedByName).toBeUndefined();
      expect(result?.approvedAt).toBeUndefined();
    });

    it('should successfully undo a rejected change', async () => {
      const changeId = 'test-change-id';
      const submissionId = 'test-submission-id';

      // Mock a change that is currently rejected
      const mockChange: TrackedChange = {
        id: changeId,
        submissionId,
        field: 'content',
        oldValue: 'old content',
        newValue: 'new content',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: new Date().toISOString(),
        status: 'rejected',
        rejectedBy: 'user2',
        rejectedByName: 'User Two',
        rejectedAt: new Date().toISOString()
      };

      // Mock getObject to return our change via direct key lookup
      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange)
      });

      // Mock putObject to simulate saving
      mockEnv.R2.put = jest.fn().mockResolvedValue(undefined);

      const result = await undoChange(submissionId, changeId, mockEnv);

      expect(result).not.toBeNull();
      expect(result?.status).toBe('pending');
      expect(result?.rejectedBy).toBeUndefined();
      expect(result?.rejectedByName).toBeUndefined();
      expect(result?.rejectedAt).toBeUndefined();
    });

    it('should return null for non-existent change', async () => {
      const changeId = 'non-existent-change-id';
      const submissionId = 'test-submission-id';

      // Mock R2.get to return null (change not found at direct key)
      mockEnv.R2.get = jest.fn().mockResolvedValue(null);

      const result = await undoChange(submissionId, changeId, mockEnv);

      expect(result).toBeNull();
    });

    it('should return null for change that is already pending', async () => {
      const changeId = 'test-change-id';
      const submissionId = 'test-submission-id';

      // Mock a change that is currently pending
      const mockChange: TrackedChange = {
        id: changeId,
        submissionId,
        field: 'content',
        oldValue: 'old content',
        newValue: 'new content',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: new Date().toISOString(),
        status: 'pending'
      };

      // Mock getObject to return our change via direct key lookup
      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange)
      });

      const result = await undoChange(submissionId, changeId, mockEnv);

      expect(result).toBeNull();
    });
  });

  describe('calculateIncrementalChange', () => {
    it('should return empty for identical texts', () => {
      const result = calculateIncrementalChange('hello world', 'hello world');
      expect(result).toEqual({ oldValue: '', newValue: '' });
    });

    it('should handle single word change', () => {
      const result = calculateIncrementalChange('the quick fox', 'the slow fox');
      expect(result.oldValue).toBe('quick');
      expect(result.newValue).toBe('slow');
    });

    it('should handle disjoint changes without including unchanged text between them', () => {
      const result = calculateIncrementalChange(
        'Despotism, it is their right, it is their duty, to throw off such Government,',
        'despotism, it is their right, it is their duty, to throw off such government,'
      );
      expect(result.oldValue).toBe('Despotism, \u2026 Government,');
      expect(result.newValue).toBe('despotism, \u2026 government,');
    });

    it('should handle adjacent changes as a single group', () => {
      const result = calculateIncrementalChange(
        'the big red fox',
        'the small blue fox'
      );
      expect(result.oldValue).toBe('big red');
      expect(result.newValue).toBe('small blue');
    });

    it('should handle word insertion', () => {
      const result = calculateIncrementalChange(
        'the fox jumps',
        'the quick fox jumps'
      );
      expect(result.oldValue).toBe('');
      expect(result.newValue).toBe('quick');
    });

    it('should handle word deletion', () => {
      const result = calculateIncrementalChange(
        'the quick fox jumps',
        'the fox jumps'
      );
      expect(result.oldValue).toBe('quick');
      expect(result.newValue).toBe('');
    });

    it('should handle empty previous version', () => {
      const result = calculateIncrementalChange('', 'new text');
      expect(result.oldValue).toBe('');
      expect(result.newValue).toBe('new text');
    });

    it('should handle empty current version', () => {
      const result = calculateIncrementalChange('old text', '');
      expect(result.oldValue).toBe('old text');
      expect(result.newValue).toBe('');
    });

    it('should handle complete replacement', () => {
      const result = calculateIncrementalChange('hello world', 'goodbye earth');
      expect(result.oldValue).toBe('hello world');
      expect(result.newValue).toBe('goodbye earth');
    });
  });

  describe('deleteChange', () => {
    it('should successfully delete an existing change using direct key lookup', async () => {
      const changeId = 'test-change-id';
      const submissionId = 'test-submission-id';

      const mockChange: TrackedChange = {
        id: changeId,
        submissionId,
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: new Date().toISOString(),
        status: 'pending'
      };

      // Mock R2.get to return the change when fetched by constructed key
      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange)
      });

      mockEnv.R2.delete = jest.fn().mockResolvedValue(undefined);

      const result = await deleteChange(submissionId, changeId, mockEnv);

      expect(result).not.toBeNull();
      expect(result?.submissionId).toBe(submissionId);
      // Verify R2.delete was called (the deleteObject function calls env.R2.delete)
      expect(mockEnv.R2.delete).toHaveBeenCalled();
    });

    it('should return null for non-existent change', async () => {
      // Mock R2.get to return null (change doesn't exist at constructed key)
      mockEnv.R2.get = jest.fn().mockResolvedValue(null);

      const result = await deleteChange('test-submission-id', 'non-existent-id', mockEnv);

      expect(result).toBeNull();
    });

    it('should delete changes regardless of status', async () => {
      const changeId = 'approved-change-id';
      const submissionId = 'test-submission-id';

      const mockChange: TrackedChange = {
        id: changeId,
        submissionId,
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: new Date().toISOString(),
        status: 'approved',
        approvedBy: 'user2',
        approvedByName: 'User Two',
        approvedAt: new Date().toISOString()
      };

      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange)
      });

      mockEnv.R2.delete = jest.fn().mockResolvedValue(undefined);

      const result = await deleteChange(submissionId, changeId, mockEnv);

      expect(result).not.toBeNull();
      expect(result?.submissionId).toBe(submissionId);
    });

    it('should construct the R2 key from submissionId and changeId without scanning', async () => {
      const changeId = 'test-change-id';
      const submissionId = 'test-submission-id';

      const mockChange: TrackedChange = {
        id: changeId,
        submissionId,
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: new Date().toISOString(),
        status: 'pending'
      };

      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange)
      });

      mockEnv.R2.delete = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.list = jest.fn();

      await deleteChange(submissionId, changeId, mockEnv);

      // R2.list should NOT have been called — we construct the key directly
      expect(mockEnv.R2.list).not.toHaveBeenCalled();
    });
  });

  describe('getCascadeDependencies', () => {
    it('should return empty array when target change has no regionMap', async () => {
      const submissionId = 'test-submission-id';
      const changeId = 'change-1';

      const mockChange: TrackedChange = {
        id: changeId,
        submissionId,
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T00:00:00Z',
        status: 'pending'
        // No regionMap
      };

      mockEnv.R2.list = jest.fn().mockResolvedValue({
        objects: [{ key: `tracked-changes/submission/${submissionId}/${changeId}` }]
      });

      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange)
      });

      const result = await getCascadeDependencies(submissionId, changeId, mockEnv);

      expect(result).toEqual([]);
    });

    it('should return dependent changes with overlapping regions', async () => {
      const submissionId = 'test-submission-id';
      const change1: TrackedChange = {
        id: 'change-1',
        submissionId,
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T00:00:00Z',
        status: 'pending',
        regionMap: { field: 'content', ranges: [{ start: 10, end: 20 }] }
      };

      const change2: TrackedChange = {
        id: 'change-2',
        submissionId,
        field: 'content',
        oldValue: 'old2',
        newValue: 'new2',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T01:00:00Z',
        status: 'pending',
        regionMap: { field: 'content', ranges: [{ start: 15, end: 25 }] }
      };

      const change3: TrackedChange = {
        id: 'change-3',
        submissionId,
        field: 'content',
        oldValue: 'old3',
        newValue: 'new3',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T02:00:00Z',
        status: 'pending',
        regionMap: { field: 'content', ranges: [{ start: 50, end: 60 }] }
      };

      // Mock R2.list to return all three changes
      mockEnv.R2.list = jest.fn().mockResolvedValue({
        objects: [
          { key: `tracked-changes/submission/${submissionId}/change-1` },
          { key: `tracked-changes/submission/${submissionId}/change-2` },
          { key: `tracked-changes/submission/${submissionId}/change-3` }
        ]
      });

      // Mock R2.get to return the correct change for each key
      mockEnv.R2.get = jest.fn().mockImplementation((key: string) => {
        if (key.endsWith('change-1')) {
          return Promise.resolve({ json: () => Promise.resolve(change1) });
        }
        if (key.endsWith('change-2')) {
          return Promise.resolve({ json: () => Promise.resolve(change2) });
        }
        if (key.endsWith('change-3')) {
          return Promise.resolve({ json: () => Promise.resolve(change3) });
        }
        return Promise.resolve(null);
      });

      const result = await getCascadeDependencies(submissionId, 'change-1', mockEnv);

      // change-2 overlaps with change-1 (15-25 overlaps 10-20)
      // change-3 does NOT overlap (50-60 vs 10-20)
      expect(result).toContain('change-2');
      expect(result).not.toContain('change-3');
    });

    it('should stop cascade at an accepted change with overlapping region', async () => {
      const submissionId = 'test-submission-id';
      const change1: TrackedChange = {
        id: 'change-1',
        submissionId,
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T00:00:00Z',
        status: 'pending',
        regionMap: { field: 'content', ranges: [{ start: 10, end: 20 }] }
      };

      const change2: TrackedChange = {
        id: 'change-2',
        submissionId,
        field: 'content',
        oldValue: 'old2',
        newValue: 'new2',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T01:00:00Z',
        status: 'approved', // Accepted - acts as boundary, not included in result
        regionMap: { field: 'content', ranges: [{ start: 15, end: 25 }] }
      };

      mockEnv.R2.list = jest.fn().mockResolvedValue({
        objects: [
          { key: `tracked-changes/submission/${submissionId}/change-1` },
          { key: `tracked-changes/submission/${submissionId}/change-2` }
        ]
      });

      mockEnv.R2.get = jest.fn().mockImplementation((key: string) => {
        if (key.endsWith('change-1')) {
          return Promise.resolve({ json: () => Promise.resolve(change1) });
        }
        if (key.endsWith('change-2')) {
          return Promise.resolve({ json: () => Promise.resolve(change2) });
        }
        return Promise.resolve(null);
      });

      const result = await getCascadeDependencies(submissionId, 'change-1', mockEnv);

      // Accepted change is not included, and it terminates the cascade
      expect(result).toEqual([]);
    });

    it('should exclude pending changes that come after an accepted boundary', async () => {
      const submissionId = 'test-submission-id';
      // Target change
      const change1: TrackedChange = {
        id: 'change-1',
        submissionId,
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T00:00:00Z',
        status: 'pending',
        regionMap: { field: 'content', ranges: [{ start: 10, end: 20 }] }
      };

      // Pending change overlapping — should be included
      const change2: TrackedChange = {
        id: 'change-2',
        submissionId,
        field: 'content',
        oldValue: 'old2',
        newValue: 'new2',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T01:00:00Z',
        status: 'pending',
        regionMap: { field: 'content', ranges: [{ start: 15, end: 25 }] }
      };

      // Accepted change overlapping — acts as boundary
      const change3: TrackedChange = {
        id: 'change-3',
        submissionId,
        field: 'content',
        oldValue: 'old3',
        newValue: 'new3',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T02:00:00Z',
        status: 'approved',
        regionMap: { field: 'content', ranges: [{ start: 12, end: 18 }] }
      };

      // Pending change overlapping — but comes AFTER accepted boundary, should be excluded
      const change4: TrackedChange = {
        id: 'change-4',
        submissionId,
        field: 'content',
        oldValue: 'old4',
        newValue: 'new4',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T03:00:00Z',
        status: 'pending',
        regionMap: { field: 'content', ranges: [{ start: 10, end: 20 }] }
      };

      mockEnv.R2.list = jest.fn().mockResolvedValue({
        objects: [
          { key: `tracked-changes/submission/${submissionId}/change-1` },
          { key: `tracked-changes/submission/${submissionId}/change-2` },
          { key: `tracked-changes/submission/${submissionId}/change-3` },
          { key: `tracked-changes/submission/${submissionId}/change-4` }
        ]
      });

      mockEnv.R2.get = jest.fn().mockImplementation((key: string) => {
        if (key.endsWith('change-1')) {
          return Promise.resolve({ json: () => Promise.resolve(change1) });
        }
        if (key.endsWith('change-2')) {
          return Promise.resolve({ json: () => Promise.resolve(change2) });
        }
        if (key.endsWith('change-3')) {
          return Promise.resolve({ json: () => Promise.resolve(change3) });
        }
        if (key.endsWith('change-4')) {
          return Promise.resolve({ json: () => Promise.resolve(change4) });
        }
        return Promise.resolve(null);
      });

      const result = await getCascadeDependencies(submissionId, 'change-1', mockEnv);

      // change-2 is pending and overlapping — included
      // change-3 is accepted and overlapping — boundary, stops cascade
      // change-4 is pending and overlapping — but after the boundary, excluded
      expect(result).toEqual(['change-2']);
    });

    it('should not include changes for different fields', async () => {
      const submissionId = 'test-submission-id';
      const change1: TrackedChange = {
        id: 'change-1',
        submissionId,
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T00:00:00Z',
        status: 'pending',
        regionMap: { field: 'content', ranges: [{ start: 10, end: 20 }] }
      };

      const change2: TrackedChange = {
        id: 'change-2',
        submissionId,
        field: 'title', // Different field
        oldValue: 'old2',
        newValue: 'new2',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T01:00:00Z',
        status: 'pending',
        regionMap: { field: 'title', ranges: [{ start: 10, end: 20 }] }
      };

      mockEnv.R2.list = jest.fn().mockResolvedValue({
        objects: [
          { key: `tracked-changes/submission/${submissionId}/change-1` },
          { key: `tracked-changes/submission/${submissionId}/change-2` }
        ]
      });

      mockEnv.R2.get = jest.fn().mockImplementation((key: string) => {
        if (key.endsWith('change-1')) {
          return Promise.resolve({ json: () => Promise.resolve(change1) });
        }
        if (key.endsWith('change-2')) {
          return Promise.resolve({ json: () => Promise.resolve(change2) });
        }
        return Promise.resolve(null);
      });

      const result = await getCascadeDependencies(submissionId, 'change-1', mockEnv);

      expect(result).toEqual([]);
    });

    it('should return empty for non-existent target change', async () => {
      const submissionId = 'test-submission-id';

      mockEnv.R2.list = jest.fn().mockResolvedValue({
        objects: []
      });

      const result = await getCascadeDependencies(submissionId, 'non-existent', mockEnv);

      expect(result).toEqual([]);
    });

    it('should not include earlier changes (only subsequent)', async () => {
      const submissionId = 'test-submission-id';
      const change1: TrackedChange = {
        id: 'change-1',
        submissionId,
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T02:00:00Z', // Later timestamp
        status: 'pending',
        regionMap: { field: 'content', ranges: [{ start: 10, end: 20 }] }
      };

      const change2: TrackedChange = {
        id: 'change-2',
        submissionId,
        field: 'content',
        oldValue: 'old2',
        newValue: 'new2',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: '2024-01-01T00:00:00Z', // Earlier timestamp
        status: 'pending',
        regionMap: { field: 'content', ranges: [{ start: 15, end: 25 }] }
      };

      mockEnv.R2.list = jest.fn().mockResolvedValue({
        objects: [
          { key: `tracked-changes/submission/${submissionId}/change-1` },
          { key: `tracked-changes/submission/${submissionId}/change-2` }
        ]
      });

      mockEnv.R2.get = jest.fn().mockImplementation((key: string) => {
        if (key.endsWith('change-1')) {
          return Promise.resolve({ json: () => Promise.resolve(change1) });
        }
        if (key.endsWith('change-2')) {
          return Promise.resolve({ json: () => Promise.resolve(change2) });
        }
        return Promise.resolve(null);
      });

      const result = await getCascadeDependencies(submissionId, 'change-1', mockEnv);

      // change-2 has an earlier timestamp, so it should not be included
      expect(result).toEqual([]);
    });
  });

  describe('batchCreateTrackedChanges', () => {
    it('should create multiple changes and return them all', async () => {
      const submissionId = 'test-submission-id';

      mockEnv.R2.put = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.delete = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.list = jest.fn().mockResolvedValue({ objects: [] });

      const changesData = [
        {
          field: 'content',
          oldValue: 'old1',
          newValue: 'new1',
          changedBy: 'user1',
          changedByName: 'User One'
        },
        {
          field: 'content',
          oldValue: 'old2',
          newValue: 'new2',
          changedBy: 'user1',
          changedByName: 'User One'
        }
      ];

      const result = await batchCreateTrackedChanges(submissionId, changesData, mockEnv);

      expect(result).toHaveLength(2);
      expect(result[0].field).toBe('content');
      expect(result[0].oldValue).toBe('old1');
      expect(result[0].newValue).toBe('new1');
      expect(result[0].status).toBe('pending');
      expect(result[0].submissionId).toBe(submissionId);
      expect(result[1].oldValue).toBe('old2');
      expect(result[1].newValue).toBe('new2');
      // Each change should have a unique ID
      expect(result[0].id).not.toBe(result[1].id);
    });

    it('should include regionMap when provided', async () => {
      const submissionId = 'test-submission-id';

      mockEnv.R2.put = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.delete = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.list = jest.fn().mockResolvedValue({ objects: [] });

      const regionMap: RegionMap = {
        field: 'content',
        ranges: [{ start: 10, end: 20 }]
      };

      const changesData = [
        {
          field: 'content',
          oldValue: 'old',
          newValue: 'new',
          changedBy: 'user1',
          changedByName: 'User One',
          regionMap
        }
      ];

      const result = await batchCreateTrackedChanges(submissionId, changesData, mockEnv);

      expect(result).toHaveLength(1);
      expect(result[0].regionMap).toEqual(regionMap);
    });

    it('should rollback on error (all-or-nothing)', async () => {
      const submissionId = 'test-submission-id';

      let putCallCount = 0;
      mockEnv.R2.put = jest.fn().mockImplementation(() => {
        putCallCount++;
        // Fail on the third put call (second change's R2 write, after the first change's R2 + cache writes)
        if (putCallCount >= 3) {
          return Promise.reject(new Error('R2 write failed'));
        }
        return Promise.resolve(undefined);
      });
      mockEnv.R2.delete = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.list = jest.fn().mockResolvedValue({ objects: [] });

      const changesData = [
        {
          field: 'content',
          oldValue: 'old1',
          newValue: 'new1',
          changedBy: 'user1',
          changedByName: 'User One'
        },
        {
          field: 'content',
          oldValue: 'old2',
          newValue: 'new2',
          changedBy: 'user1',
          changedByName: 'User One'
        }
      ];

      await expect(batchCreateTrackedChanges(submissionId, changesData, mockEnv))
        .rejects.toThrow('R2 write failed');

      // Verify R2.delete was called for rollback
      expect(mockEnv.R2.delete).toHaveBeenCalled();
    });

    it('should preserve custom timestamps when provided', async () => {
      const submissionId = 'test-submission-id';

      mockEnv.R2.put = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.delete = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.list = jest.fn().mockResolvedValue({ objects: [] });

      const customTimestamp = '2024-06-15T12:00:00Z';

      const changesData = [
        {
          field: 'content',
          oldValue: 'old',
          newValue: 'new',
          changedBy: 'user1',
          changedByName: 'User One',
          timestamp: customTimestamp
        }
      ];

      const result = await batchCreateTrackedChanges(submissionId, changesData, mockEnv);

      expect(result).toHaveLength(1);
      expect(result[0].timestamp).toBe(customTimestamp);
    });
  });

  describe('TrackedChange with regionMap', () => {
    it('should support TrackedChange without regionMap (backward compatible)', () => {
      const change: TrackedChange = {
        id: 'test-id',
        submissionId: 'sub-id',
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: new Date().toISOString(),
        status: 'pending'
      };

      expect(change.regionMap).toBeUndefined();
    });

    it('should support TrackedChange with regionMap', () => {
      const change: TrackedChange = {
        id: 'test-id',
        submissionId: 'sub-id',
        field: 'content',
        oldValue: 'old',
        newValue: 'new',
        changedBy: 'user1',
        changedByName: 'User One',
        timestamp: new Date().toISOString(),
        status: 'pending',
        regionMap: {
          field: 'content',
          ranges: [{ start: 0, end: 10 }, { start: 20, end: 30 }]
        }
      };

      expect(change.regionMap).toBeDefined();
      expect(change.regionMap!.field).toBe('content');
      expect(change.regionMap!.ranges).toHaveLength(2);
      expect(change.regionMap!.ranges[0]).toEqual({ start: 0, end: 10 });
    });
  });

  describe('createTrackedChange with regionMap', () => {
    it('should store regionMap when provided', async () => {
      const submissionId = 'test-submission-id';

      // Mock R2 and list for getLatestProposedVersion (returns no prior changes)
      mockEnv.R2.list = jest.fn().mockResolvedValue({ objects: [] });
      mockEnv.R2.put = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.delete = jest.fn().mockResolvedValue(undefined);

      const regionMap: RegionMap = {
        field: 'content',
        ranges: [{ start: 5, end: 15 }]
      };

      const result = await createTrackedChange(
        submissionId,
        'content',
        'old value',
        'new value',
        'user1',
        'User One',
        mockEnv,
        undefined, // richTextOldValue
        undefined, // richTextNewValue
        regionMap
      );

      expect(result.regionMap).toEqual(regionMap);
      expect(result.submissionId).toBe(submissionId);
      expect(result.status).toBe('pending');
    });

    it('should create change without regionMap when not provided', async () => {
      const submissionId = 'test-submission-id';

      mockEnv.R2.list = jest.fn().mockResolvedValue({ objects: [] });
      mockEnv.R2.put = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.delete = jest.fn().mockResolvedValue(undefined);

      const result = await createTrackedChange(
        submissionId,
        'content',
        'old value',
        'new value',
        'user1',
        'User One',
        mockEnv
      );

      expect(result.regionMap).toBeUndefined();
      expect(result.submissionId).toBe(submissionId);
      expect(result.status).toBe('pending');
    });
  });
});