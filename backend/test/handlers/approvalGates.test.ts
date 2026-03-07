import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock cacheService before importing the module under test
jest.mock('../../src/services/cacheService', () => ({
  getObject: jest.fn(),
  putObject: jest.fn(),
  deleteObject: jest.fn(),
  listObjects: jest.fn(),
}));

// Mock councilManagerService
jest.mock('../../src/services/councilManagerService', () => ({
  getCouncilManagersForRole: jest.fn(),
}));

// Mock trackedChangesService
jest.mock('../../src/services/trackedChangesService', () => ({
  getTrackedChanges: jest.fn(),
}));

import { computeApprovalGates } from '../../src/handlers/contentSubmission';
import { ContentSubmission, ContentApproval, UserType, CouncilRole, ApprovalGates } from '../../src/types';
import { getObject } from '../../src/services/cacheService';
import { getCouncilManagersForRole } from '../../src/services/councilManagerService';
import { getTrackedChanges } from '../../src/services/trackedChangesService';

// Cast mocked functions for easy assertion
const mockGetObject = getObject as jest.MockedFunction<typeof getObject>;
const mockGetCouncilManagersForRole = getCouncilManagersForRole as jest.MockedFunction<typeof getCouncilManagersForRole>;
const mockGetTrackedChanges = getTrackedChanges as jest.MockedFunction<typeof getTrackedChanges>;

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
    id: `approval-${Math.random().toString(36).substring(7)}`,
    submissionId: 'sub-1',
    approverId: 'approver-1',
    approverEmail: 'approver@example.com',
    approverName: 'Approver',
    approverType: UserType.Member,
    status: 'approved',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const mockEnv = {} as any;

describe('computeApprovalGates', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks: no council managers, no comms cadre, no tracked changes
    mockGetCouncilManagersForRole.mockResolvedValue([]);
    mockGetObject.mockResolvedValue(null);
    mockGetTrackedChanges.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---- Test 1: All gates start as unmet with empty approvals ----
  it('should return all gates unmet when there are no approvals and no required approvers', async () => {
    const submission = makeSubmission();

    const gates = await computeApprovalGates(submission, mockEnv);

    // Council manager gate: not met
    expect(gates.councilManager.met).toBe(false);
    expect(gates.councilManager.approver).toBeUndefined();
    expect(gates.councilManager.approverName).toBeUndefined();
    expect(gates.councilManager.date).toBeUndefined();

    // Comms cadre gate: not met
    expect(gates.commsCadre.met).toBe(false);
    expect(gates.commsCadre.approver).toBeUndefined();
    expect(gates.commsCadre.approverName).toBeUndefined();
    expect(gates.commsCadre.date).toBeUndefined();

    // Required approvers: met (vacuously — 0 of 0)
    expect(gates.requiredApprovers.met).toBe(true);
    expect(gates.requiredApprovers.approved).toBe(0);
    expect(gates.requiredApprovers.total).toBe(0);
    expect(gates.requiredApprovers.details).toEqual([]);

    // Tracked changes: met (no changes)
    expect(gates.trackedChanges.met).toBe(true);
    expect(gates.trackedChanges.pending).toBe(0);
    expect(gates.trackedChanges.total).toBe(0);
  });

  it('should return all gates unmet with required approvers but no approvals', async () => {
    const submission = makeSubmission({
      requiredApprovers: ['alice@example.com', 'bob@example.com'],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.requiredApprovers.met).toBe(false);
    expect(gates.requiredApprovers.approved).toBe(0);
    expect(gates.requiredApprovers.total).toBe(2);
    expect(gates.requiredApprovers.details).toHaveLength(2);
    expect(gates.requiredApprovers.details[0].email).toBe('alice@example.com');
    expect(gates.requiredApprovers.details[0].status).toBe('pending');
    expect(gates.requiredApprovers.details[1].email).toBe('bob@example.com');
    expect(gates.requiredApprovers.details[1].status).toBe('pending');
  });

  // ---- Test 2: Council manager approval sets councilManager.met = true ----
  it('should mark councilManager gate as met when a council manager approves (by approverType)', async () => {
    const submission = makeSubmission({
      approvals: [
        makeApproval({
          approverEmail: 'council@example.com',
          approverName: 'Council Manager',
          approverType: UserType.CouncilManager,
          status: 'approved',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.councilManager.met).toBe(true);
    expect(gates.councilManager.approver).toBe('council@example.com');
    expect(gates.councilManager.approverName).toBe('Council Manager');
    expect(gates.councilManager.date).toBe('2026-01-02T00:00:00Z');
  });

  it('should mark councilManager gate as met when approver is in council members list (by email lookup)', async () => {
    // The approver has Member type but their email is in the council list
    mockGetCouncilManagersForRole.mockImplementation(async (role) => {
      if (role === CouncilRole.CommunicationsManager) {
        return [
          {
            id: 'cm-1',
            userId: 'user-cm',
            role: CouncilRole.CommunicationsManager,
            email: 'comms-mgr@example.com',
            name: 'Comms Manager',
            active: true,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ];
      }
      return [];
    });

    const submission = makeSubmission({
      approvals: [
        makeApproval({
          approverEmail: 'comms-mgr@example.com',
          approverName: 'Comms Manager',
          approverType: UserType.Member, // Not explicitly CouncilManager type
          status: 'approved',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.councilManager.met).toBe(true);
    expect(gates.councilManager.approver).toBe('comms-mgr@example.com');
  });

  it('should mark councilManager gate as met when approver has CouncilManager role in approverRoles', async () => {
    const submission = makeSubmission({
      approvals: [
        makeApproval({
          approverEmail: 'multi-role@example.com',
          approverName: 'Multi Role User',
          approverType: UserType.Member,
          approverRoles: ['CouncilManager', 'CommsCadre'],
          status: 'approved',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.councilManager.met).toBe(true);
  });

  it('should NOT mark councilManager gate as met when council manager rejected', async () => {
    const submission = makeSubmission({
      approvals: [
        makeApproval({
          approverEmail: 'council@example.com',
          approverType: UserType.CouncilManager,
          status: 'rejected',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.councilManager.met).toBe(false);
  });

  // ---- Test 3: CommsCadre approval sets commsCadre.met = true ----
  it('should mark commsCadre gate as met when a comms cadre member approves (by approverType)', async () => {
    const submission = makeSubmission({
      approvals: [
        makeApproval({
          approverEmail: 'cadre@example.com',
          approverName: 'Cadre Member',
          approverType: UserType.CommsCadre,
          status: 'approved',
          createdAt: '2026-01-03T00:00:00Z',
          updatedAt: '2026-01-03T00:00:00Z',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.commsCadre.met).toBe(true);
    expect(gates.commsCadre.approver).toBe('cadre@example.com');
    expect(gates.commsCadre.approverName).toBe('Cadre Member');
    expect(gates.commsCadre.date).toBe('2026-01-03T00:00:00Z');
  });

  it('should mark commsCadre gate as met when approver is in active comms cadre list (by email lookup)', async () => {
    // Mock the comms cadre active list
    mockGetObject.mockResolvedValue([
      { email: 'cadre-member@example.com', active: true },
      { email: 'inactive-cadre@example.com', active: false },
    ]);

    const submission = makeSubmission({
      approvals: [
        makeApproval({
          approverEmail: 'cadre-member@example.com',
          approverName: 'Cadre Member',
          approverType: UserType.Member, // Not explicitly CommsCadre type
          status: 'approved',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.commsCadre.met).toBe(true);
    expect(gates.commsCadre.approver).toBe('cadre-member@example.com');
  });

  it('should NOT mark commsCadre gate as met when approver is in comms cadre list but inactive', async () => {
    mockGetObject.mockResolvedValue([
      { email: 'inactive-cadre@example.com', active: false },
    ]);

    const submission = makeSubmission({
      approvals: [
        makeApproval({
          approverEmail: 'inactive-cadre@example.com',
          approverName: 'Inactive Cadre',
          approverType: UserType.Member,
          status: 'approved',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.commsCadre.met).toBe(false);
  });

  it('should mark commsCadre gate as met when approver has CommsCadre role in approverRoles', async () => {
    const submission = makeSubmission({
      approvals: [
        makeApproval({
          approverEmail: 'multi-role@example.com',
          approverType: UserType.Member,
          approverRoles: ['CommsCadre'],
          status: 'approved',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.commsCadre.met).toBe(true);
  });

  // ---- Test 4: Required approver progress is tracked correctly ----
  it('should track required approver progress correctly (partial approval)', async () => {
    const submission = makeSubmission({
      requiredApprovers: ['alice@example.com', 'bob@example.com', 'carol@example.com'],
      approvals: [
        makeApproval({
          approverEmail: 'alice@example.com',
          approverName: 'Alice',
          status: 'approved',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        }),
        makeApproval({
          approverEmail: 'bob@example.com',
          approverName: 'Bob',
          status: 'rejected',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.requiredApprovers.met).toBe(false);
    expect(gates.requiredApprovers.approved).toBe(1);
    expect(gates.requiredApprovers.total).toBe(3);

    // Check details
    const aliceDetail = gates.requiredApprovers.details.find(d => d.email === 'alice@example.com');
    expect(aliceDetail).toBeDefined();
    expect(aliceDetail!.status).toBe('approved');
    expect(aliceDetail!.name).toBe('Alice');
    expect(aliceDetail!.date).toBe('2026-01-02T00:00:00Z');

    const bobDetail = gates.requiredApprovers.details.find(d => d.email === 'bob@example.com');
    expect(bobDetail).toBeDefined();
    expect(bobDetail!.status).toBe('rejected');

    const carolDetail = gates.requiredApprovers.details.find(d => d.email === 'carol@example.com');
    expect(carolDetail).toBeDefined();
    expect(carolDetail!.status).toBe('pending');
    expect(carolDetail!.date).toBeUndefined();
  });

  it('should mark required approvers as met when all approve', async () => {
    const submission = makeSubmission({
      requiredApprovers: ['alice@example.com', 'bob@example.com'],
      approvals: [
        makeApproval({
          approverEmail: 'alice@example.com',
          approverName: 'Alice',
          status: 'approved',
        }),
        makeApproval({
          approverEmail: 'bob@example.com',
          approverName: 'Bob',
          status: 'approved',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.requiredApprovers.met).toBe(true);
    expect(gates.requiredApprovers.approved).toBe(2);
    expect(gates.requiredApprovers.total).toBe(2);
  });

  it('should deduplicate approvals by latest per approver', async () => {
    // First the approver rejects, then later approves — should use the latest (approved)
    const submission = makeSubmission({
      requiredApprovers: ['alice@example.com'],
      approvals: [
        makeApproval({
          id: 'approval-1',
          approverEmail: 'alice@example.com',
          approverName: 'Alice',
          status: 'rejected',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }),
        makeApproval({
          id: 'approval-2',
          approverEmail: 'alice@example.com',
          approverName: 'Alice',
          status: 'approved',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.requiredApprovers.met).toBe(true);
    expect(gates.requiredApprovers.approved).toBe(1);
    const aliceDetail = gates.requiredApprovers.details.find(d => d.email === 'alice@example.com');
    expect(aliceDetail!.status).toBe('approved');
  });

  it('should deduplicate — later rejection overrides earlier approval', async () => {
    const submission = makeSubmission({
      requiredApprovers: ['alice@example.com'],
      approvals: [
        makeApproval({
          id: 'approval-1',
          approverEmail: 'alice@example.com',
          approverName: 'Alice',
          status: 'approved',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }),
        makeApproval({
          id: 'approval-2',
          approverEmail: 'alice@example.com',
          approverName: 'Alice',
          status: 'rejected',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.requiredApprovers.met).toBe(false);
    expect(gates.requiredApprovers.approved).toBe(0);
    const aliceDetail = gates.requiredApprovers.details.find(d => d.email === 'alice@example.com');
    expect(aliceDetail!.status).toBe('rejected');
  });

  // ---- Test 5: Tracked changes pending count is accurate ----
  it('should report tracked changes correctly when all are resolved', async () => {
    mockGetTrackedChanges.mockResolvedValue([
      { id: 'c1', status: 'approved', submissionId: 'sub-1', field: 'content', oldValue: '', newValue: '', changedBy: 'u', changedByName: 'U', timestamp: '' },
      { id: 'c2', status: 'rejected', submissionId: 'sub-1', field: 'content', oldValue: '', newValue: '', changedBy: 'u', changedByName: 'U', timestamp: '' },
    ] as any);

    const submission = makeSubmission();
    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.trackedChanges.met).toBe(true);
    expect(gates.trackedChanges.pending).toBe(0);
    expect(gates.trackedChanges.total).toBe(2);
  });

  it('should report tracked changes correctly when some are pending', async () => {
    mockGetTrackedChanges.mockResolvedValue([
      { id: 'c1', status: 'approved', submissionId: 'sub-1', field: 'content', oldValue: '', newValue: '', changedBy: 'u', changedByName: 'U', timestamp: '' },
      { id: 'c2', status: 'pending', submissionId: 'sub-1', field: 'content', oldValue: '', newValue: '', changedBy: 'u', changedByName: 'U', timestamp: '' },
      { id: 'c3', status: 'pending', submissionId: 'sub-1', field: 'content', oldValue: '', newValue: '', changedBy: 'u', changedByName: 'U', timestamp: '' },
    ] as any);

    const submission = makeSubmission();
    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.trackedChanges.met).toBe(false);
    expect(gates.trackedChanges.pending).toBe(2);
    expect(gates.trackedChanges.total).toBe(3);
  });

  it('should report tracked changes gate as met when there are no changes', async () => {
    mockGetTrackedChanges.mockResolvedValue([]);

    const submission = makeSubmission();
    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.trackedChanges.met).toBe(true);
    expect(gates.trackedChanges.pending).toBe(0);
    expect(gates.trackedChanges.total).toBe(0);
  });

  // ---- Test 6: Gates compute correctly even when an override exists ----
  it('should compute gates independently of approval override fields on the submission', async () => {
    // A submission with an approval override does not change the gates —
    // gates reflect the actual approvals, not the override status.
    const submission = makeSubmission({
      approvalOverride: true,
      approvalOverrideBy: 'admin@example.com',
      approvalOverrideReason: 'Urgent publication needed',
      approvalOverrideAt: '2026-01-05T00:00:00Z',
      approvals: [], // No actual approvals — all gates should be unmet
      requiredApprovers: ['alice@example.com'],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    // Override does not affect gates — they still reflect actual approval state
    expect(gates.councilManager.met).toBe(false);
    expect(gates.commsCadre.met).toBe(false);
    expect(gates.requiredApprovers.met).toBe(false);
    expect(gates.requiredApprovers.approved).toBe(0);
    expect(gates.requiredApprovers.total).toBe(1);
    expect(gates.trackedChanges.met).toBe(true);
  });

  // ---- Additional edge case tests ----
  it('should handle case-insensitive email matching for required approvers', async () => {
    const submission = makeSubmission({
      requiredApprovers: ['Alice@Example.COM'],
      approvals: [
        makeApproval({
          approverEmail: 'alice@example.com',
          approverName: 'Alice',
          status: 'approved',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.requiredApprovers.met).toBe(true);
    expect(gates.requiredApprovers.approved).toBe(1);
  });

  it('should handle multiple gates being met simultaneously', async () => {
    // Set up council manager list
    mockGetCouncilManagersForRole.mockImplementation(async (role) => {
      if (role === CouncilRole.OperationsManager) {
        return [
          {
            id: 'cm-1',
            userId: 'user-cm',
            role: CouncilRole.OperationsManager,
            email: 'ops@example.com',
            name: 'Ops Manager',
            active: true,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ];
      }
      return [];
    });

    // Set up comms cadre list
    mockGetObject.mockResolvedValue([
      { email: 'cadre@example.com', active: true },
    ]);

    // No pending tracked changes
    mockGetTrackedChanges.mockResolvedValue([
      { id: 'c1', status: 'approved', submissionId: 'sub-1', field: 'content', oldValue: '', newValue: '', changedBy: 'u', changedByName: 'U', timestamp: '' },
    ] as any);

    const submission = makeSubmission({
      requiredApprovers: ['req@example.com'],
      approvals: [
        makeApproval({
          approverEmail: 'ops@example.com',
          approverName: 'Ops Manager',
          approverType: UserType.Member,
          status: 'approved',
        }),
        makeApproval({
          approverEmail: 'cadre@example.com',
          approverName: 'Cadre Member',
          approverType: UserType.Member,
          status: 'approved',
        }),
        makeApproval({
          approverEmail: 'req@example.com',
          approverName: 'Required Approver',
          approverType: UserType.Member,
          status: 'approved',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.councilManager.met).toBe(true);
    expect(gates.commsCadre.met).toBe(true);
    expect(gates.requiredApprovers.met).toBe(true);
    expect(gates.requiredApprovers.approved).toBe(1);
    expect(gates.requiredApprovers.total).toBe(1);
    expect(gates.trackedChanges.met).toBe(true);
    expect(gates.trackedChanges.pending).toBe(0);
    expect(gates.trackedChanges.total).toBe(1);
  });

  it('should handle submission with undefined approvals array gracefully', async () => {
    const submission = makeSubmission();
    // Explicitly set approvals to undefined to test fallback
    (submission as any).approvals = undefined;

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.councilManager.met).toBe(false);
    expect(gates.commsCadre.met).toBe(false);
    expect(gates.requiredApprovers.met).toBe(true);
    expect(gates.trackedChanges.met).toBe(true);
  });

  it('should include comment from council manager approval', async () => {
    const submission = makeSubmission({
      approvals: [
        makeApproval({
          approverEmail: 'council@example.com',
          approverName: 'Council Manager',
          approverType: UserType.CouncilManager,
          status: 'approved',
          comment: 'Looks good to me',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.councilManager.met).toBe(true);
    expect(gates.councilManager.comment).toBe('Looks good to me');
  });

  it('should include comment from comms cadre approval', async () => {
    const submission = makeSubmission({
      approvals: [
        makeApproval({
          approverEmail: 'cadre@example.com',
          approverName: 'Cadre Member',
          approverType: UserType.CommsCadre,
          status: 'approved',
          comment: 'Approved with minor notes',
        }),
      ],
    });

    const gates = await computeApprovalGates(submission, mockEnv);

    expect(gates.commsCadre.met).toBe(true);
    expect(gates.commsCadre.comment).toBe('Approved with minor notes');
  });
});
