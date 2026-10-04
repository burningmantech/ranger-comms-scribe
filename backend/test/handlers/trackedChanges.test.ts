import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { deleteChangeHandler, batchCreateHandler } from '../../src/handlers/trackedChanges';
import { CustomRequest } from '../../src/types';

// Helper to create a mock CustomRequest
function createMockRequest(overrides: {
  params?: Record<string, string>;
  user?: any;
  body?: any;
}): CustomRequest {
  return {
    params: overrides.params || {},
    user: overrides.user,
    json: jest.fn().mockResolvedValue(overrides.body || {}),
  } as unknown as CustomRequest;
}

// Helper to create mock env with R2
function createMockEnv() {
  return {
    R2: {
      get: jest.fn(),
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue({ objects: [] }),
    },
    D1: {
      prepare: jest.fn().mockReturnValue({
        bind: jest.fn().mockReturnValue({
          first: jest.fn().mockResolvedValue(null),
          run: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    },
  };
}

describe('trackedChanges handlers', () => {
  let mockEnv: any;

  beforeEach(() => {
    mockEnv = createMockEnv();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('deleteChangeHandler', () => {
    const mockChange = {
      id: 'change-1',
      submissionId: 'sub-1',
      field: 'content',
      oldValue: 'old',
      newValue: 'new',
      changedBy: 'author-user-id',
      changedByName: 'Author User',
      timestamp: '2024-01-01T00:00:00Z',
      status: 'pending',
    };

    it('should allow the change author to delete their own change', async () => {
      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange),
      });

      const request = createMockRequest({
        params: { submissionId: 'sub-1', changeId: 'change-1' },
        user: {
          id: 'author-user-id',
          name: 'Author User',
          userType: 'Member',
        },
      });

      const response = await deleteChangeHandler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should allow Admin to delete any change', async () => {
      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange),
      });

      const request = createMockRequest({
        params: { submissionId: 'sub-1', changeId: 'change-1' },
        user: {
          id: 'admin-user-id',
          name: 'Admin User',
          userType: 'Admin',
        },
      });

      const response = await deleteChangeHandler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should allow CommsCadre to delete any change', async () => {
      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange),
      });

      const request = createMockRequest({
        params: { submissionId: 'sub-1', changeId: 'change-1' },
        user: {
          id: 'cadre-user-id',
          name: 'Cadre User',
          userType: 'CommsCadre',
        },
      });

      const response = await deleteChangeHandler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should reject deletion by a non-author Member', async () => {
      mockEnv.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockChange),
      });

      const request = createMockRequest({
        params: { submissionId: 'sub-1', changeId: 'change-1' },
        user: {
          id: 'other-user-id',
          name: 'Other User',
          userType: 'Member',
        },
      });

      const response = await deleteChangeHandler(request, mockEnv);

      expect(response.status).toBe(403);
    });

    it('should return 404 for non-existent change', async () => {
      mockEnv.R2.get = jest.fn().mockResolvedValue(null);

      const request = createMockRequest({
        params: { submissionId: 'sub-1', changeId: 'non-existent' },
        user: {
          id: 'admin-user-id',
          name: 'Admin User',
          userType: 'Admin',
        },
      });

      const response = await deleteChangeHandler(request, mockEnv);

      expect(response.status).toBe(404);
    });

    it('should return 401 when not authenticated', async () => {
      const request = createMockRequest({
        params: { submissionId: 'sub-1', changeId: 'change-1' },
        user: undefined,
      });

      const response = await deleteChangeHandler(request, mockEnv);

      expect(response.status).toBe(401);
    });
  });

  describe('batchCreateHandler', () => {
    it('should reject batch with more than 50 changes', async () => {
      const changes = Array.from({ length: 51 }, (_, i) => ({
        field: 'content',
        oldValue: `old-${i}`,
        newValue: `new-${i}`,
      }));

      const request = createMockRequest({
        params: { submissionId: 'sub-1' },
        user: {
          id: 'user-1',
          name: 'User One',
          userType: 'Member',
        },
        body: { changes },
      });

      const response = await batchCreateHandler(request, mockEnv);

      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('50');
    });

    it('should accept batch with exactly 50 changes', async () => {
      mockEnv.R2.put = jest.fn().mockResolvedValue(undefined);
      mockEnv.R2.delete = jest.fn().mockResolvedValue(undefined);

      const changes = Array.from({ length: 50 }, (_, i) => ({
        field: 'content',
        oldValue: `old-${i}`,
        newValue: `new-${i}`,
      }));

      const request = createMockRequest({
        params: { submissionId: 'sub-1' },
        user: {
          id: 'user-1',
          name: 'User One',
          userType: 'Member',
        },
        body: { changes },
      });

      const response = await batchCreateHandler(request, mockEnv);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.changes).toHaveLength(50);
    });

    it('should reject empty changes array', async () => {
      const request = createMockRequest({
        params: { submissionId: 'sub-1' },
        user: {
          id: 'user-1',
          name: 'User One',
          userType: 'Member',
        },
        body: { changes: [] },
      });

      const response = await batchCreateHandler(request, mockEnv);

      expect(response.status).toBe(400);
    });
  });
});
