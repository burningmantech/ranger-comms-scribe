/**
 * The submission status follows its tracked changes (syncSubmissionStatus): resolving the
 * last pending change after the approvals makes it approved, a new or undone change sends an
 * approved submission back to in_review, and a sent one never changes. Real storage (an
 * in-memory store and the real cache); only the room broadcasts are mocked.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../src/handlers/websocket', () => ({
  broadcastToSubmissionRoom: jest.fn().mockResolvedValue(undefined),
  broadcastToDocumentRoom: jest.fn().mockResolvedValue(undefined),
}));

import {
  createTrackedChangeHandler,
  updateChangeStatusHandler,
  batchUpdateStatusHandler,
  undoChangeHandler,
  deleteChangeHandler,
  batchCreateHandler,
} from '../../src/handlers/trackedChanges';
import { recomputeApprovalStatus } from '../../src/handlers/contentSubmission';
import { broadcastToSubmissionRoom } from '../../src/handlers/websocket';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { ContentApproval, ContentSubmission, CustomRequest, UserType } from '../../src/types';

const SUB = 'sub-status';
const reviewer = { id: 'rev-1', email: 'rev@example.com', name: 'Reviewer', userType: 'CommsCadre' };
const author = { id: 'author-1', email: 'author@example.com', name: 'Author', userType: 'Member' };

let env: any;

function approval(email: string, approverType: UserType, status: 'approved' | 'rejected' = 'approved'): ContentApproval {
  return {
    id: `a-${email}`, submissionId: SUB, approverId: email, approverEmail: email, approverName: email,
    approverType, status, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  };
}

/** Every gate but the tracked changes one: required approver, council manager, Comms Cadre. */
const allApprovals = (): ContentApproval[] => [
  approval('required@example.com', UserType.Member),
  approval('council@example.com', UserType.CouncilManager),
  approval('cadre@example.com', UserType.CommsCadre),
];

async function seed(overrides: Partial<ContentSubmission> = {}): Promise<void> {
  const submission: ContentSubmission = {
    id: SUB, title: 'Status sync', content: 'Hello world.', submittedBy: author.id,
    submittedAt: '2026-10-01T00:00:00Z', status: 'in_review', formFields: [], comments: [],
    approvals: allApprovals(), changes: [], commsCadreApprovals: 0, councilManagerApprovals: [],
    announcementSent: false, assignedCouncilManagers: [], requiredApprovers: ['required@example.com'],
    ...overrides,
  };
  await putObject(`content_submissions/${SUB}`, submission, env);
}

const stored = async () => (await getObject<ContentSubmission>(`content_submissions/${SUB}`, env))!;

function req(user: any, params: Record<string, string>, body: any): CustomRequest {
  return { params, user, json: jest.fn().mockResolvedValue(body) } as unknown as CustomRequest;
}

async function createChange(user: any = author, newValue = 'Hello there world.'): Promise<string> {
  const res = await createTrackedChangeHandler(
    req(user, { submissionId: SUB }, { field: 'content', oldValue: 'Hello world.', newValue }),
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()).id;
}

const decide = (changeId: string, status: 'approved' | 'rejected') =>
  updateChangeStatusHandler(req(reviewer, { changeId }, { status, submissionId: SUB }), env);

/** The status_changed broadcasts sent so far, as their data. */
const statusBroadcasts = () => (broadcastToSubmissionRoom as jest.Mock).mock.calls
  .filter(([, message]) => message.type === 'status_changed')
  .map(([id, message]) => ({ id, ...message.data }));

beforeEach(() => {
  jest.clearAllMocks();
  clearMemoryCache();
  env = { STORE: new MemoryObjectStore() };
});

describe('resolving the last change after the approvals', () => {
  it('accepting it makes the submission approved and tells the room', async () => {
    await seed();
    const changeId = await createChange();
    expect((await stored()).status).toBe('in_review');

    expect((await decide(changeId, 'approved')).status).toBe(200);

    const after = await stored();
    expect(after.status).toBe('approved');
    expect(after.finalApprovalDate).toBeTruthy();
    const broadcasts = statusBroadcasts();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ id: SUB, status: 'approved', previousStatus: 'in_review', reason: 'tracked_changes' });
    expect(broadcasts[0].approvalGates.trackedChanges).toMatchObject({ met: true, pending: 0 });
  });

  it('rejecting it does too', async () => {
    await seed();
    const changeId = await createChange();
    await decide(changeId, 'rejected');
    expect((await stored()).status).toBe('approved');
  });

  it('a batch accept of the remaining changes does too', async () => {
    await seed();
    const first = await createChange(author, 'Hello there world.');
    const second = await createChange(author, 'Hello there big world.');
    const res = await batchUpdateStatusHandler(
      req(reviewer, {}, { changeIds: [first, second], status: 'approved', submissionId: SUB }),
      env,
    );
    expect(res.status).toBe(200);
    expect((await stored()).status).toBe('approved');
  });

  it('only once every pending change is resolved', async () => {
    await seed();
    const first = await createChange(author, 'Hello there world.');
    const second = await createChange(author, 'Hello there big world.');
    await decide(first, 'approved');
    expect((await stored()).status).toBe('in_review');
    expect(statusBroadcasts()).toHaveLength(0);
    await decide(second, 'approved');
    expect((await stored()).status).toBe('approved');
  });

  it('deleting the last pending change (an author undoing their own edit) does too', async () => {
    await seed();
    const changeId = await createChange();
    const res = await deleteChangeHandler(req(author, { submissionId: SUB, changeId }, {}), env);
    expect(res.status).toBe(200);
    expect((await stored()).status).toBe('approved');
  });

  it('stays in review while an approval gate is not met, with no broadcast', async () => {
    await seed({ approvals: allApprovals().filter(a => a.approverType !== UserType.CommsCadre) });
    const changeId = await createChange();
    await decide(changeId, 'approved');
    expect((await stored()).status).toBe('in_review');
    expect(statusBroadcasts()).toHaveLength(0);
  });
});

describe('an approved submission whose content changes', () => {
  it('goes back to in_review when a new change is created', async () => {
    await seed({ status: 'approved', finalApprovalDate: '2026-10-02T00:00:00Z' });
    await createChange();

    const after = await stored();
    expect(after.status).toBe('in_review');
    expect(after.finalApprovalDate).toBeUndefined();
    expect(statusBroadcasts()).toEqual([
      expect.objectContaining({ status: 'in_review', previousStatus: 'approved' }),
    ]);
  });

  it('goes back to in_review on a batch create', async () => {
    await seed({ status: 'approved' });
    const res = await batchCreateHandler(
      req(author, { submissionId: SUB }, { changes: [{ field: 'content', oldValue: 'Hello world.', newValue: 'Hi world.' }] }),
      env,
    );
    expect(res.status).toBe(200);
    expect((await stored()).status).toBe('in_review');
  });

  it('goes back to in_review when an undo makes a change pending again, and is approved again once it is resolved', async () => {
    await seed();
    const changeId = await createChange();
    await decide(changeId, 'approved');
    expect((await stored()).status).toBe('approved');

    const res = await undoChangeHandler(req(reviewer, { changeId }, { submissionId: SUB }), env);
    expect(res.status).toBe(200);
    expect((await stored()).status).toBe('in_review');

    await decide(changeId, 'rejected');
    expect((await stored()).status).toBe('approved');
    expect(statusBroadcasts().map(b => b.status)).toEqual(['approved', 'in_review', 'approved']);
  });

  it('an override approval no longer holds after a new change, and resolving it does not restore it', async () => {
    await seed({ status: 'approved', approvals: [], approvalOverride: true, approvalOverrideBy: 'cm@example.com' });
    const changeId = await createChange();
    let after = await stored();
    expect(after.status).toBe('in_review');
    expect(after.approvalOverride).toBe(false);
    expect(after.approvalOverrideBy).toBe('cm@example.com');

    await decide(changeId, 'approved');
    after = await stored();
    expect(after.status).toBe('in_review');
  });

  it('accepting or rejecting changes does not demote an approval with nothing pending', async () => {
    // e.g. an override approval: the people gates are not met, but nothing is pending
    await seed({ status: 'approved', approvals: [], approvalOverride: true });
    const first = await createChange();
    // back to review by the create; approve again by override, as the Comms Manager would
    await putObject(`content_submissions/${SUB}`, { ...(await stored()), status: 'approved', approvalOverride: true }, env);
    await decide(first, 'approved');
    expect((await stored()).status).toBe('approved');
  });
});

describe('the approval_state broadcast', () => {
  it('carries the gates after a change op that leaves the status alone', async () => {
    await seed({ approvals: [] });
    await createChange();
    const calls = (broadcastToSubmissionRoom as jest.Mock).mock.calls.filter(([, m]) => m.type === 'approval_state');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(SUB);
    expect(calls[0][1].data.status).toBe('in_review');
    expect(calls[0][1].data.approvalGates.trackedChanges).toMatchObject({ met: false, pending: 1, total: 1 });
    expect(calls[0][1].data.approvalGates.commsCadre.met).toBe(false);
    expect(statusBroadcasts()).toHaveLength(0);
  });
});

describe('a sent submission', () => {
  it('stays sent when a change is created, resolved or undone', async () => {
    await seed({ status: 'sent' });
    const changeId = await createChange();
    expect((await stored()).status).toBe('sent');
    await decide(changeId, 'approved');
    expect((await stored()).status).toBe('sent');
    await undoChangeHandler(req(reviewer, { changeId }, { submissionId: SUB }), env);
    expect((await stored()).status).toBe('sent');
    expect(broadcastToSubmissionRoom).not.toHaveBeenCalled();
  });

  it('is not turned back into approved by recomputeApprovalStatus', async () => {
    await seed({ status: 'sent' });
    const result = await recomputeApprovalStatus(await stored(), env);
    expect(result.status).toBe('sent');
  });
});
