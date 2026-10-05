import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { deleteChangeHandler, batchCreateHandler, batchUpdateStatusHandler } from '../../src/handlers/trackedChanges';
import { CustomRequest } from '../../src/types';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { createMockObjectStore } from '../helpers/mockObjectStore';

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

// Helper to create mock env with a mocked object store
function createMockEnv() {
  clearMemoryCache();
  return {
    STORE: {
      get: jest.fn(),
      head: jest.fn().mockResolvedValue(null),
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue({ objects: [] }),
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
      mockEnv.STORE.get = jest.fn().mockResolvedValue({
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
      mockEnv.STORE.get = jest.fn().mockResolvedValue({
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
      mockEnv.STORE.get = jest.fn().mockResolvedValue({
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
      mockEnv.STORE.get = jest.fn().mockResolvedValue({
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
      mockEnv.STORE.get = jest.fn().mockResolvedValue(null);

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
      mockEnv.STORE.put = jest.fn().mockResolvedValue(undefined);
      mockEnv.STORE.delete = jest.fn().mockResolvedValue(undefined);

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

  describe('batchUpdateStatusHandler revertedRichText', () => {
    const lexical = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      root: {
        type: 'root', version: 1, direction: null, format: '', indent: 0, ...extra,
        children: [{
          type: 'paragraph', version: 1, direction: null, format: '', indent: 0,
          children: [{ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text }],
        }],
      },
    });
    const admin = { id: 'admin-user-id', name: 'Admin User', userType: 'Admin' };
    let counter = 0;

    // A submission with an original and two pending changes, in a memory-backed store.
    // Unique ids per test: the cache is module-level.
    async function setup() {
      const env: any = { STORE: createMockObjectStore() };
      const submissionId = `batch-sub-${++counter}`;
      const original = lexical('Hello world');
      await putObject(`original_content/${submissionId}`, { content: 'Hello world', richTextContent: original }, env);
      await putObject(`content_submissions/${submissionId}`, {
        id: submissionId, content: 'Hello big bright world', richTextContent: lexical('Hello big bright world'),
      }, env);
      const change = (id: string, oldValue: string, newValue: string, at: string) => ({
        id, submissionId, field: 'content', oldValue, newValue, completeProposedVersion: newValue,
        richTextOldValue: lexical(oldValue), richTextNewValue: lexical(newValue),
        changedBy: 'author', changedByName: 'Author', timestamp: at, status: 'pending',
      });
      await putObject(`tracked-changes/submission/${submissionId}/c1`,
        change('c1', 'Hello world', 'Hello big world', '2026-10-05T10:00:00Z'), env);
      await putObject(`tracked-changes/submission/${submissionId}/c2`,
        change('c2', 'Hello big world', 'Hello big bright world', '2026-10-05T10:00:05Z'), env);
      return { env, submissionId, original };
    }

    async function batchReject(env: any, submissionId: string, extra: Record<string, unknown> = {}) {
      const request = createMockRequest({
        user: admin,
        body: { changeIds: ['c1', 'c2'], status: 'rejected', submissionId, ...extra },
      });
      const response = await batchUpdateStatusHandler(request, env);
      expect(response.status).toBe(200);
      // Read back from the store, not the in-memory cache
      clearMemoryCache();
      return {
        submission: await getObject<any>(`content_submissions/${submissionId}`, env),
        proposed: await getObject<any>(`proposed_versions/${submissionId}`, env),
      };
    }

    it('stores the editor state sent with a batch reject', async () => {
      const { env, submissionId } = await setup();
      // Differs from the server's recompute (an extra root field), as an editor-side revert would
      const editorState = lexical('Hello world', { editorSide: true });

      const { submission, proposed } = await batchReject(env, submissionId, { revertedRichText: editorState });

      expect(submission.richTextContent).toBe(editorState);
      expect(submission.content).toBe('Hello world');
      expect(proposed.proposedVersionsRichText).toBe(editorState);
    });

    it('stores the recompute when no revertedRichText is sent', async () => {
      const { env, submissionId, original } = await setup();

      const { submission, proposed } = await batchReject(env, submissionId);

      expect(submission.richTextContent).toBe(original);
      expect(proposed.proposedVersionsRichText).toBe(original);
    });

    it('ignores a revertedRichText that is not Lexical JSON', async () => {
      const { env, submissionId, original } = await setup();

      const { submission } = await batchReject(env, submissionId, { revertedRichText: 'plain text' });

      expect(submission.richTextContent).toBe(original);
    });
  });
});
