/**
 * POST /api/content/submissions/:id/comments/:commentId/resolve: resolve or reopen a comment
 * thread, for submission comments and change comments, with the submission's view rule.
 * Real router and storage (dev-bypass users); only the room broadcasts are mocked.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../src/handlers/websocket', () => ({
  broadcastToSubmissionRoom: jest.fn().mockResolvedValue(undefined),
  broadcastToDocumentRoom: jest.fn().mockResolvedValue(undefined),
}));

import { router } from '../../src/handlers/contentSubmission';
import { broadcastToSubmissionRoom } from '../../src/handlers/websocket';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { addChangeComment, createTrackedChange, getChangeComments } from '../../src/services/trackedChangesService';
import { ContentComment, ContentSubmission } from '../../src/types';

const SUB = 'sub-comments';
let env: any;

const comment = (id: string, content: string): ContentComment => ({
  id, submissionId: SUB, content, authorId: 'dev-admin', authorName: 'Dev Admin',
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', isSuggestion: false, resolved: false,
});

async function seed(overrides: Partial<ContentSubmission> = {}) {
  const submission: ContentSubmission = {
    id: SUB, title: 'Comments', content: 'Hello.', submittedBy: 'someone-else', submittedAt: '2026-10-01T00:00:00Z',
    status: 'in_review', formFields: [], comments: [comment('c1', 'Please check this.'), comment('c2', '@reply:c1 Done.')],
    approvals: [], changes: [], commsCadreApprovals: 0, councilManagerApprovals: [], announcementSent: false,
    assignedCouncilManagers: [], requiredApprovers: [], ...overrides,
  };
  await putObject(`content_submissions/${SUB}`, submission, env);
}

const stored = async () => (await getObject<ContentSubmission>(`content_submissions/${SUB}`, env))!;

function call(path: string, body: unknown, devUser?: 'user2' | 'member', method = 'POST') {
  return router.fetch(new Request(`http://localhost/api/content${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(devUser ? { 'X-Dev-User': devUser } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}
const resolve = (commentId: string, body: unknown, devUser?: 'user2' | 'member') =>
  call(`/submissions/${SUB}/comments/${commentId}/resolve`, body, devUser);

beforeEach(() => {
  jest.clearAllMocks();
  clearMemoryCache();
  env = { STORE: new MemoryObjectStore(), DEV_BYPASS_AUTH: 'true' };
});

describe('resolving a submission comment', () => {
  it('marks it resolved with who and when, and tells the room', async () => {
    await seed();
    const res = await resolve('c1', { resolved: true }, 'user2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'c1', resolved: true, resolvedBy: 'user2@localhost', resolvedByName: 'Test Reviewer' });
    expect(typeof body.resolvedAt).toBe('string');

    const saved = (await stored()).comments.find(c => c.id === 'c1')!;
    expect(saved).toMatchObject({ resolved: true, resolvedBy: 'user2@localhost', resolvedAt: body.resolvedAt });
    // replies are untouched (they follow their thread in the UI)
    expect((await stored()).comments.find(c => c.id === 'c2')!.resolved).toBe(false);

    expect(broadcastToSubmissionRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToSubmissionRoom).toHaveBeenCalledWith(SUB, expect.objectContaining({
      type: 'comment_resolved',
      userId: 'dev-user2',
      data: { commentId: 'c1', resolved: true, resolvedBy: 'user2@localhost', resolvedByName: 'Test Reviewer', resolvedAt: body.resolvedAt },
    }), env);
  });

  it('reopens it, clearing who resolved it', async () => {
    await seed();
    await resolve('c1', { resolved: true });
    const res = await resolve('c1', { resolved: false });
    expect(res.status).toBe(200);
    const saved = (await stored()).comments.find(c => c.id === 'c1')!;
    expect(saved.resolved).toBe(false);
    expect(saved.resolvedBy).toBeUndefined();
    expect(saved.resolvedAt).toBeUndefined();
    expect((broadcastToSubmissionRoom as jest.Mock).mock.calls[1][1].data).toEqual(
      expect.objectContaining({ commentId: 'c1', resolved: false }),
    );
  });

  it('requires a boolean resolved', async () => {
    await seed();
    expect((await resolve('c1', {})).status).toBe(400);
    expect((await resolve('c1', { resolved: 'yes' })).status).toBe(400);
    expect(broadcastToSubmissionRoom).not.toHaveBeenCalled();
  });

  it('404s for an unknown comment or submission', async () => {
    await seed();
    expect((await resolve('nope', { resolved: true })).status).toBe(404);
    expect((await call('/submissions/missing/comments/c1/resolve', { resolved: true })).status).toBe(404);
    expect(broadcastToSubmissionRoom).not.toHaveBeenCalled();
  });

  it('is refused to a user who cannot view the submission, and allowed to its author', async () => {
    await seed();
    expect((await resolve('c1', { resolved: true }, 'member')).status).toBe(403);
    expect((await stored()).comments[0].resolved).toBe(false);

    await seed({ submittedBy: 'dev-member' });
    expect((await resolve('c1', { resolved: true }, 'member')).status).toBe(200);
  });
});

describe('resolving a change comment', () => {
  it('finds it among the submission\'s change comments and resolves it', async () => {
    await seed();
    const change = await createTrackedChange(SUB, 'content', 'Hello.', 'Hello there.', 'dev-admin', 'Dev Admin', env);
    const changeComment = await addChangeComment(change.id, SUB, 'Why?', 'dev-admin', 'Dev Admin', env);

    const res = await resolve(changeComment.id, { resolved: true });
    expect(res.status).toBe(200);
    const comments = await getChangeComments(change.id, env);
    expect(comments[0]).toMatchObject({ id: changeComment.id, resolved: true, resolvedBy: 'dev@localhost' });
    expect((broadcastToSubmissionRoom as jest.Mock).mock.calls[0][1].data).toEqual(
      expect.objectContaining({ commentId: changeComment.id, changeId: change.id, resolved: true }),
    );

    // with the change id given directly, and reopened
    expect((await resolve(changeComment.id, { resolved: false, changeId: change.id })).status).toBe(200);
    expect((await getChangeComments(change.id, env))[0].resolved).toBe(false);
  });
});

describe('PUT /submissions/:id', () => {
  it('ignores comments and approvals in the body (a loaded copy would undo a resolve)', async () => {
    await seed();
    await resolve('c1', { resolved: true });
    const res = await call(`/submissions/${SUB}`, {
      title: 'Renamed',
      comments: [comment('c1', 'Please check this.')],
      approvals: [{ id: 'x', status: 'approved' }],
    }, undefined, 'PUT');
    expect(res.status).toBe(200);
    const after = await stored();
    expect(after.title).toBe('Renamed');
    expect(after.comments.find(c => c.id === 'c1')!.resolved).toBe(true);
    expect(after.comments).toHaveLength(2);
    expect(after.approvals).toEqual([]);
  });
});
