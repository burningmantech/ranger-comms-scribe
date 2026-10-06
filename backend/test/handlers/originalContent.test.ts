import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { router } from '../../src/handlers/contentSubmission';
import { updateChangeStatusHandler, batchUpdateStatusHandler } from '../../src/handlers/trackedChanges';
import { CustomRequest } from '../../src/types';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { createMockObjectStore } from '../helpers/mockObjectStore';

/**
 * The content as submitted (originalContent) is set when a submission is created and never
 * changes: accept / reject rewrite content and richTextContent, and the review tool's
 * Original view and Compare baseline must not follow them.
 */

const lexical = (text: string) => JSON.stringify({
  root: {
    type: 'root', version: 1, direction: null, format: '', indent: 0,
    children: [{
      type: 'paragraph', version: 1, direction: null, format: '', indent: 0,
      children: [{ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text }],
    }],
  },
});

const admin = { id: 'admin-user-id', name: 'Admin User', userType: 'Admin' };

function handlerRequest(params: Record<string, string>, body: any): CustomRequest {
  return { params, user: admin, json: jest.fn().mockResolvedValue(body) } as unknown as CustomRequest;
}

async function api(env: any, method: string, path: string, body?: unknown): Promise<any> {
  const response = await router.fetch(new Request(`http://localhost/api/content${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-admin-session' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  expect(response.status).toBe(200);
  return response.json();
}

/** Read back from the store, not the in-memory cache. */
async function stored(env: any, submissionId: string): Promise<any> {
  clearMemoryCache();
  return getObject<any>(`content_submissions/${submissionId}`, env);
}

describe('originalContent (the content as submitted)', () => {
  let env: any;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    clearMemoryCache();
    env = { STORE: createMockObjectStore(), DEV_BYPASS_AUTH: 'true' };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A submission created through the API, with one pending change (as the editor saves it). */
  async function submissionWithChange(): Promise<{ id: string; original: string; edited: string }> {
    const original = lexical('Hello world');
    const created = await api(env, 'POST', '/submissions', { title: 'T', content: original, status: 'submitted' });
    expect(created.originalContent).toBe(original);
    const edited = lexical('Hello big world');
    await putObject(`original_content/${created.id}`, { content: original, richTextContent: '' }, env);
    await putObject(`tracked-changes/submission/${created.id}/c1`, {
      id: 'c1', submissionId: created.id, field: 'content', oldValue: 'Hello world', newValue: 'Hello big world',
      completeProposedVersion: 'Hello big world', richTextOldValue: original, richTextNewValue: edited,
      changedBy: 'author', changedByName: 'Author', timestamp: '2026-10-05T10:00:00Z', status: 'pending',
    }, env);
    return { id: created.id, original, edited };
  }

  it('is set on create and returned by GET', async () => {
    const original = lexical('As submitted');
    const created = await api(env, 'POST', '/submissions', { title: 'T', content: original, status: 'submitted' });

    expect((await stored(env, created.id)).originalContent).toBe(original);
    expect((await api(env, 'GET', `/submissions/${created.id}`)).originalContent).toBe(original);
  });

  it('is unchanged when an accept rewrites richTextContent', async () => {
    const { id, original, edited } = await submissionWithChange();

    const response = await updateChangeStatusHandler(handlerRequest({ changeId: 'c1' }, { status: 'approved', submissionId: id }), env);
    expect(response.status).toBe(200);

    const after = await stored(env, id);
    expect(after.richTextContent).toBe(edited); // the accept did rewrite the working fields
    expect(after.originalContent).toBe(original);
  });

  it('is unchanged when a reject stores the editor state', async () => {
    const { id, original } = await submissionWithChange();
    const editorState = lexical('Hello world (editor)');

    const response = await batchUpdateStatusHandler(
      handlerRequest({}, { changeIds: ['c1'], status: 'rejected', submissionId: id, revertedRichText: editorState }),
      env,
    );
    expect(response.status).toBe(200);

    const after = await stored(env, id);
    expect(after.richTextContent).toBe(editorState);
    expect(after.originalContent).toBe(original);
  });

  it('ignores a PUT that tries to change it', async () => {
    const original = lexical('As submitted');
    const created = await api(env, 'POST', '/submissions', { title: 'T', content: original, status: 'submitted' });

    const updated = await api(env, 'PUT', `/submissions/${created.id}`, {
      ...created, title: 'New title', content: 'edited', originalContent: 'hacked', originalRichTextContent: 'hacked',
    });

    expect(updated.title).toBe('New title');
    expect(updated.originalContent).toBe(original);
    expect(updated.originalRichTextContent).toBeUndefined();
    const after = await stored(env, created.id);
    expect(after.content).toBe('edited');
    expect(after.originalContent).toBe(original);
    expect(after.originalRichTextContent).toBeUndefined();
  });

  it('is not added by a PUT to a submission created before it existed', async () => {
    await putObject('content_submissions/legacy-1', {
      id: 'legacy-1', title: 'Old', content: 'Old content', submittedBy: 'dev-admin', submittedAt: '2025-01-01T00:00:00Z',
      status: 'submitted', formFields: [], comments: [], approvals: [], changes: [],
    }, env);

    const updated = await api(env, 'PUT', '/submissions/legacy-1', { title: 'Still old', originalContent: 'made up' });

    expect(updated.originalContent).toBeUndefined();
    expect((await stored(env, 'legacy-1')).originalContent).toBeUndefined();
  });
});
