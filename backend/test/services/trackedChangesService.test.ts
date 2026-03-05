import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { undoChange, TrackedChange, calculateIncrementalChange } from '../../src/services/trackedChangesService';
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

      const result = await undoChange(changeId, mockEnv);

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

      const result = await undoChange(changeId, mockEnv);

      expect(result).not.toBeNull();
      expect(result?.status).toBe('pending');
      expect(result?.rejectedBy).toBeUndefined();
      expect(result?.rejectedByName).toBeUndefined();
      expect(result?.rejectedAt).toBeUndefined();
    });

    it('should return null for non-existent change', async () => {
      const changeId = 'non-existent-change-id';
      
      // Mock the listObjects to return empty
      mockEnv.R2.list = jest.fn().mockResolvedValue({
        objects: []
      });

      const result = await undoChange(changeId, mockEnv);

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

      // Mock the listObjects to return our change
      mockEnv.R2.list = jest.fn().mockResolvedValue({
        objects: [{ key: `tracked-changes/submission/${submissionId}/${changeId}` }]
      });

      // Mock getObject to return our change
      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange)
      });

      const result = await undoChange(changeId, mockEnv);

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
});