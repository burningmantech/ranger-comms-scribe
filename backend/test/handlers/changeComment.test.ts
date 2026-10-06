import { describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../src/handlers/websocket', () => ({
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

function request(changeId: string, body: any, user: any = { id: 'u1', email: 'rev@example.com', name: 'Reviewer', userType: 'CommsCadre' }): CustomRequest {
  return {
    params: { changeId },
    user,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as CustomRequest;
}

describe('addChangeCommentHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('broadcasts comment_added to the submission room with the comment and change id', async () => {
    const comment = {
      id: 'c1', changeId: 'ch1', submissionId: 'sub-1', content: 'Why?', authorId: 'u1', authorName: 'Reviewer',
      createdAt: '2026-10-05T00:00:00.000Z',
    };
    (getTrackedChanges as jest.Mock).mockResolvedValue([{ id: 'ch1', submissionId: 'sub-1' }]);
    (addChangeComment as jest.Mock).mockResolvedValue(comment);

    const response = await addChangeCommentHandler(request('ch1', { content: 'Why?' }), {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(comment);
    expect(broadcastToSubmissionRoom).toHaveBeenCalledTimes(1);
    expect(broadcastToSubmissionRoom).toHaveBeenCalledWith('sub-1', expect.objectContaining({
      type: 'comment_added',
      userId: 'u1',
      userName: 'Reviewer',
      userEmail: 'rev@example.com',
      data: { comment, changeId: 'ch1' },
    }), {});
  });

  it('does not broadcast when the change does not exist', async () => {
    (getTrackedChanges as jest.Mock).mockResolvedValue([]);

    const response = await addChangeCommentHandler(request('missing', { content: 'Why?' }), {});

    expect(response.status).toBe(404);
    expect(broadcastToSubmissionRoom).not.toHaveBeenCalled();
  });
});
