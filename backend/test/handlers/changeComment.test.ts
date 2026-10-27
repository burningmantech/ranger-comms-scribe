import { describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../src/handlers/websocket', () => ({
  recheckRoomAccess: jest.fn().mockResolvedValue(0),
  broadcastToSubmissionRoom: jest.fn().mockResolvedValue(undefined),
  broadcastToDocumentRoom: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/trackedChangesService', () => {
  const actual = jest.requireActual('../../src/services/trackedChangesService');
  return {
    ...actual,
    getTrackedChanges: jest.fn(),
    addChangeComment: jest.fn(),
  };
});

import { addChangeCommentHandler } from '../../src/handlers/trackedChanges';
import { broadcastToSubmissionRoom } from '../../src/handlers/websocket';
import { getTrackedChanges, addChangeComment } from '../../src/services/trackedChangesService';
import { CustomRequest } from '../../src/types';
import { clearMemoryCache, putObject } from '../../src/services/cacheService';
import { createMockObjectStore } from '../helpers/mockObjectStore';

function request(changeId: string, body: any, user: any = { id: 'u1', email: 'rev@example.com', name: 'Reviewer', userType: 'CommsCadre' }): CustomRequest {
  return {
    params: { changeId },
    user,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as CustomRequest;
}

describe('addChangeCommentHandler', () => {
  let env: any;
  beforeEach(async () => {
    jest.clearAllMocks();
    clearMemoryCache();
    env = { STORE: createMockObjectStore() };
    await putObject('content_submissions/sub-1', { id: 'sub-1', submittedBy: 'author', status: 'in_review', requiredApprovers: [] }, env);
  });

  it('broadcasts comment_added to the submission room with the comment and change id', async () => {
    const comment = {
      id: 'c1', changeId: 'ch1', submissionId: 'sub-1', content: 'Why?', authorId: 'u1', authorName: 'Reviewer',
      createdAt: '2026-10-05T00:00:00.000Z',
    };
    (getTrackedChanges as jest.Mock).mockResolvedValue([{ id: 'ch1', submissionId: 'sub-1' }]);
    (addChangeComment as jest.Mock).mockResolvedValue(comment);

    const response = await addChangeCommentHandler(request('ch1', { content: 'Why?' }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(comment);
    expect(broadcastToSubmissionRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToSubmissionRoom).toHaveBeenCalledWith('sub-1', expect.objectContaining({
      type: 'comment_added',
      userId: 'u1',
      userName: 'Reviewer',
      userEmail: 'rev@example.com',
      data: { comment, changeId: 'ch1' },
    }), env);
  });

  it("refuses someone who can't see the request", async () => {
    (getTrackedChanges as jest.Mock).mockResolvedValue([{ id: 'ch1', submissionId: 'sub-1' }]);
    const outsider = { id: 'u2', email: 'outsider@example.com', name: 'Outsider', userType: 'Member' };

    const response = await addChangeCommentHandler(request('ch1', { content: 'Hi' }, outsider), env);

    expect(response.status).toBe(403);
    expect(addChangeComment).not.toHaveBeenCalled();
    expect(broadcastToSubmissionRoom).not.toHaveBeenCalled();
  });

  it('does not broadcast when the change does not exist', async () => {
    (getTrackedChanges as jest.Mock).mockResolvedValue([]);

    const response = await addChangeCommentHandler(request('missing', { content: 'Why?' }), env);

    expect(response.status).toBe(404);
    expect(broadcastToSubmissionRoom).not.toHaveBeenCalled();
  });
});
