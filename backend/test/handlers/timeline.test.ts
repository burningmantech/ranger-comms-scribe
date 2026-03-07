import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock cacheService before importing the module under test
jest.mock('../../src/services/cacheService', () => ({
  getObject: jest.fn(),
  putObject: jest.fn(),
  deleteObject: jest.fn(),
  listObjects: jest.fn(),
}));

// Mock trackedChangesService
jest.mock('../../src/services/trackedChangesService', () => ({
  getTrackedChanges: jest.fn(),
}));

import { getTimelineHandler } from '../../src/handlers/timeline';
import { ContentSubmission, ContentApproval, ContentComment, UserType, TimelineEvent } from '../../src/types';
import { getObject } from '../../src/services/cacheService';
import { getTrackedChanges } from '../../src/services/trackedChangesService';
import { TrackedChange } from '../../src/services/trackedChangesService';

// Cast mocked functions for easy assertion
const mockGetObject = getObject as jest.MockedFunction<typeof getObject>;
const mockGetTrackedChanges = getTrackedChanges as jest.MockedFunction<typeof getTrackedChanges>;

const mockEnv = {} as any;

// Helper to create a minimal valid ContentSubmission
function makeSubmission(overrides: Partial<ContentSubmission> = {}): ContentSubmission {
  return {
    id: 'sub-1',
    title: 'Test Submission',
    content: 'Test content',
    submittedBy: 'user-1',
    submittedAt: '2026-01-01T00:00:00Z',
    status: 'submitted',
    formFields: [],
    comments: [],
    approvals: [],
    changes: [],
    commsCadreApprovals: 0,
    councilManagerApprovals: [],
    announcementSent: false,
    assignedCouncilManagers: [],
    requiredApprovers: [],
    ...overrides,
  };
}

// Helper to create a ContentApproval
function makeApproval(overrides: Partial<ContentApproval> = {}): ContentApproval {
  return {
    id: 'appr-1',
    submissionId: 'sub-1',
    approverId: 'approver-1',
    approverEmail: 'approver@example.com',
    approverName: 'Approver One',
    approverType: UserType.CommsCadre,
    status: 'approved',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T12:00:00Z',
    ...overrides,
  };
}

// Helper to create a ContentComment
function makeComment(overrides: Partial<ContentComment> = {}): ContentComment {
  return {
    id: 'comment-1',
    submissionId: 'sub-1',
    content: 'This looks great!',
    authorId: 'user-2',
    authorName: 'Commenter',
    createdAt: '2026-01-03T00:00:00Z',
    updatedAt: '2026-01-03T00:00:00Z',
    isSuggestion: false,
    resolved: false,
    ...overrides,
  };
}

// Helper to create a TrackedChange
function makeTrackedChange(overrides: Partial<TrackedChange> = {}): TrackedChange {
  return {
    id: 'tc-1',
    submissionId: 'sub-1',
    field: 'content',
    oldValue: 'old',
    newValue: 'new',
    changedBy: 'user-3',
    changedByName: 'Editor',
    timestamp: '2026-01-04T00:00:00Z',
    status: 'pending',
    ...overrides,
  };
}

// Helper to build a fake CustomRequest
function makeRequest(submissionId: string, authenticated = true): any {
  return {
    params: { submissionId },
    user: authenticated ? { id: 'user-1', email: 'user@example.com', name: 'Test User' } : undefined,
  };
}

// Helper to parse the JSON body from a Response
async function parseBody(response: Response): Promise<TimelineEvent[]> {
  return JSON.parse(await response.text());
}

describe('getTimelineHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no tracked changes
    mockGetTrackedChanges.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---- Test 1: Returns events sorted by timestamp descending ----
  it('should return events sorted by timestamp descending', async () => {
    const submission = makeSubmission({
      submittedAt: '2026-01-01T00:00:00Z',
      approvals: [
        makeApproval({
          id: 'appr-early',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        }),
      ],
      comments: [
        makeComment({
          id: 'cmt-late',
          createdAt: '2026-01-05T00:00:00Z',
        }),
      ],
    });

    mockGetObject.mockResolvedValue(submission);
    mockGetTrackedChanges.mockResolvedValue([
      makeTrackedChange({ id: 'tc-mid', timestamp: '2026-01-03T00:00:00Z' }),
    ]);

    const response = await getTimelineHandler(makeRequest('sub-1'), mockEnv);
    expect(response.status).toBe(200);

    const events = await parseBody(response);
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Verify descending order
    for (let i = 1; i < events.length; i++) {
      const prevTs = new Date(events[i - 1].timestamp).getTime();
      const currTs = new Date(events[i].timestamp).getTime();
      expect(prevTs).toBeGreaterThanOrEqual(currTs);
    }
  });

  // ---- Test 2: Includes submission_created event ----
  it('should include a submission_created event with deterministic ID', async () => {
    const submission = makeSubmission({
      id: 'sub-42',
      title: 'My Title',
      submittedBy: 'user-1',
      submittedAt: '2026-01-01T00:00:00Z',
    });

    mockGetObject.mockResolvedValue(submission);

    const response = await getTimelineHandler(makeRequest('sub-42'), mockEnv);
    const events = await parseBody(response);

    const createdEvent = events.find(e => e.type === 'submission_created');
    expect(createdEvent).toBeDefined();
    expect(createdEvent!.id).toBe('created-sub-42');
    expect(createdEvent!.timestamp).toBe('2026-01-01T00:00:00Z');
    expect(createdEvent!.actorId).toBe('user-1');
    expect(createdEvent!.summary).toContain('My Title');
  });

  // ---- Test 3: Includes approval events with deterministic IDs and updatedAt timestamp ----
  it('should include approval events using updatedAt timestamp and deterministic ID', async () => {
    const submission = makeSubmission({
      approvals: [
        makeApproval({
          id: 'appr-100',
          approverName: 'Jane',
          status: 'approved',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T15:00:00Z',
        }),
      ],
    });

    mockGetObject.mockResolvedValue(submission);

    const response = await getTimelineHandler(makeRequest('sub-1'), mockEnv);
    const events = await parseBody(response);

    const approvalEvent = events.find(e => e.type === 'approval_decision');
    expect(approvalEvent).toBeDefined();
    expect(approvalEvent!.id).toBe('approval-appr-100');
    // Should use updatedAt, not createdAt
    expect(approvalEvent!.timestamp).toBe('2026-01-02T15:00:00Z');
    expect(approvalEvent!.details?.status).toBe('approved');
  });

  it('should fall back to createdAt when updatedAt is missing on approval', async () => {
    const submission = makeSubmission({
      approvals: [
        makeApproval({
          id: 'appr-200',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '', // falsy
        }),
      ],
    });

    mockGetObject.mockResolvedValue(submission);

    const response = await getTimelineHandler(makeRequest('sub-1'), mockEnv);
    const events = await parseBody(response);

    const approvalEvent = events.find(e => e.type === 'approval_decision');
    expect(approvalEvent!.timestamp).toBe('2026-01-02T00:00:00Z');
  });

  // ---- Test 4: Includes comment events with content in details ----
  it('should include comment events with summary "Commented" and content in details', async () => {
    const submission = makeSubmission({
      comments: [
        makeComment({
          id: 'cmt-5',
          content: 'Great work on this draft!',
          isSuggestion: true,
          resolved: true,
        }),
      ],
    });

    mockGetObject.mockResolvedValue(submission);

    const response = await getTimelineHandler(makeRequest('sub-1'), mockEnv);
    const events = await parseBody(response);

    const commentEvent = events.find(e => e.type === 'comment_added');
    expect(commentEvent).toBeDefined();
    expect(commentEvent!.id).toBe('comment-cmt-5');
    expect(commentEvent!.summary).toBe('Commented');
    expect(commentEvent!.details?.content).toBe('Great work on this draft!');
    expect(commentEvent!.details?.isSuggestion).toBe(true);
    expect(commentEvent!.details?.resolved).toBe(true);
  });

  // ---- Test 5: Includes tracked change events ----
  it('should include tracked change events with deterministic IDs', async () => {
    const submission = makeSubmission();
    mockGetObject.mockResolvedValue(submission);

    mockGetTrackedChanges.mockResolvedValue([
      makeTrackedChange({
        id: 'tc-77',
        field: 'content',
        changedByName: 'Editor',
        timestamp: '2026-01-04T00:00:00Z',
        status: 'approved',
        approvedBy: 'reviewer-1',
        approvedByName: 'Reviewer',
        approvedAt: '2026-01-04T01:00:00Z',
      }),
    ]);

    const response = await getTimelineHandler(makeRequest('sub-1'), mockEnv);
    const events = await parseBody(response);

    const changeEvent = events.find(e => e.type === 'tracked_changes_made');
    expect(changeEvent).toBeDefined();
    expect(changeEvent!.id).toBe('change-tc-77');
    expect(changeEvent!.details?.field).toBe('content');

    const reviewEvent = events.find(e => e.type === 'tracked_change_reviewed');
    expect(reviewEvent).toBeDefined();
    expect(reviewEvent!.id).toBe('change-review-tc-77');
    expect(reviewEvent!.details?.decision).toBe('approved');
    expect(reviewEvent!.actorId).toBe('reviewer-1');
    expect(reviewEvent!.timestamp).toBe('2026-01-04T01:00:00Z');
  });

  // ---- Test 6: Groups events by author within 2-minute window via groupKey ----
  it('should group tracked change events by author within a 2-minute window via groupKey', async () => {
    const submission = makeSubmission();
    mockGetObject.mockResolvedValue(submission);

    // The groupKey uses Math.floor(ms / 120000), so each bucket is exactly 2 minutes.
    // Bucket boundaries are at 00:00, 00:02, 00:04, etc.
    // ts1 and ts2 are within the same 2-minute bucket; ts3 is in a different bucket.
    const ts1 = '2026-01-04T00:00:10Z'; // bucket = Math.floor(ms / 120000) for 00:00:10
    const ts2 = '2026-01-04T00:01:50Z'; // same bucket (within 00:00 - 02:00)
    const ts3 = '2026-01-04T00:04:10Z'; // different bucket (within 04:00 - 06:00)

    mockGetTrackedChanges.mockResolvedValue([
      makeTrackedChange({ id: 'tc-a', changedBy: 'user-3', timestamp: ts1 }),
      makeTrackedChange({ id: 'tc-b', changedBy: 'user-3', timestamp: ts2 }),
      makeTrackedChange({ id: 'tc-c', changedBy: 'user-3', timestamp: ts3 }),
    ]);

    const response = await getTimelineHandler(makeRequest('sub-1'), mockEnv);
    const events = await parseBody(response);

    const changeEvents = events.filter(e => e.type === 'tracked_changes_made');
    expect(changeEvents).toHaveLength(3);

    // The first two should share the same groupKey (same author, same 2-min bucket)
    const groupKeyA = changeEvents.find(e => e.id === 'change-tc-a')!.groupKey;
    const groupKeyB = changeEvents.find(e => e.id === 'change-tc-b')!.groupKey;
    const groupKeyC = changeEvents.find(e => e.id === 'change-tc-c')!.groupKey;

    expect(groupKeyA).toBeDefined();
    expect(groupKeyA).toBe(groupKeyB);
    expect(groupKeyA).not.toBe(groupKeyC);
  });

  // ---- Test 7: Returns 404 for non-existent submission ----
  it('should return 404 when the submission does not exist', async () => {
    mockGetObject.mockResolvedValue(null);

    const response = await getTimelineHandler(makeRequest('nonexistent'), mockEnv);
    expect(response.status).toBe(404);
  });

  // ---- Additional: Returns 401 for unauthenticated request ----
  it('should return 401 when user is not authenticated', async () => {
    const response = await getTimelineHandler(makeRequest('sub-1', false), mockEnv);
    expect(response.status).toBe(401);
  });
});
