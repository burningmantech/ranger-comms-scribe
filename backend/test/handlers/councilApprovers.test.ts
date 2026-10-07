import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
jest.mock('../../src/handlers/websocket', () => ({
  broadcastToSubmissionRoom: jest.fn().mockResolvedValue(undefined),
  broadcastToDocumentRoom: jest.fn().mockResolvedValue(undefined),
}));
import { router as contentRouter } from '../../src/handlers/contentSubmission';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { broadcastToSubmissionRoom } from '../../src/handlers/websocket';
import { saveUser } from '../../src/services/userService';
import { withDerivedAccess } from '../../src/services/access';
import { CreateSession } from '../../src/utils/sessionManager';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

/**
 * Changing a request's approvers (PUT /submissions/:id/approvers): the Comms Cadre pick or swap
 * the council approver(s). SES and the room broadcasts are mocked.
 */

let env: any;
let sendSpy: jest.SpyInstance;
const sessions: Record<string, string> = {};

const lexical = (text: string) => JSON.stringify({ root: { type: 'root', version: 1, children: [
  { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text, format: 0, style: '', mode: 'normal', detail: 0 }] },
] } });

async function person(key: string, email: string, access: Record<string, unknown> = {}) {
  await saveUser(withDerivedAccess({
    id: `id-${key}`, email, name: key, verified: true, groups: [], roles: [],
    userType: 'Member', isAdmin: false, commsCadre: false, councilRole: null, ...access,
  } as any) as any, env);
  sessions[key] = await CreateSession(email, { email }, env);
}

async function call(router: any, method: string, path: string, who: string, body?: unknown) {
  const res: Response = await router.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessions[who]}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function submission(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, title: `Request ${id}`, content: lexical('Hello Rangers'), submittedBy: 'id-member', submittedAt: '2026-10-01T00:00:00Z',
    status: 'approved', formFields: [], comments: [], approvals: [], changes: [], commsCadreApprovals: 0,
    councilManagerApprovals: [], announcementSent: false, assignedCouncilManagers: [], requiredApprovers: [], ...overrides,
  };
}

const sent = (i = 0) => (sendSpy.mock.calls[i][0] as SendEmailCommand).input;

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  clearMemoryCache();
  env = { STORE: new MemoryObjectStore(), ANNOUNCE_EMAIL_TO: 'announce@example.org', FRONTEND_URL: 'https://scribe.example.org' };
  sendSpy = jest.spyOn(SESv2Client.prototype, 'send').mockImplementation(async () => ({ MessageId: 'm', $metadata: {} }) as any);
  await person('admin', 'admin@x.org', { isAdmin: true });
  await person('cadre', 'cadre@x.org', { commsCadre: true });
  await person('cadre2', 'cadre2@x.org', { commsCadre: true });
  await person('council', 'council@x.org', { councilRole: 'IntakeManager' });
  await person('ops', 'ops@x.org', { councilRole: 'OperationsManager' });
  await person('cm', 'cm@x.org', { commsCadre: true, councilRole: 'CommunicationsManager' });
  await person('member', 'member@x.org');
});

afterEach(() => {
  jest.restoreAllMocks();
});

const approve = (who: string, email: string) => ({
  id: `a-${who}`, submissionId: 's1', approverId: `id-${who}`, approverEmail: email, approverName: who,
  approverType: 'Member', status: 'approved', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
});
const stored = async (id = 's1') => (await getObject<any>(`content_submissions/${id}`, env))!;
const setApprovers = (who: string, approvers: unknown, id = 's1') =>
  call(contentRouter, 'PUT', `/api/content/submissions/${id}/approvers`, who, { approvers });

describe('changing approvers', () => {
  beforeEach(async () => {
    // The submitter didn't know who should approve: nobody listed yet
    await putObject('content_submissions/s1', submission('s1', { status: 'in_review', requiredApprovers: [] }), env);
  });

  it('lets the Comms Cadre pick a council approver, who is asked by email and in the app', async () => {
    let gates = (await call(contentRouter, 'GET', '/api/content/submissions/s1', 'cadre')).body.approvalGates;
    const res = await setApprovers('cadre', ['Council@X.org']);
    expect(res.status).toBe(200);
    expect((await stored()).requiredApprovers).toEqual(['council@x.org']);
    gates = res.body.submission.approvalGates;
    expect(gates.councilManager).toMatchObject({ met: false, approvers: [expect.objectContaining({ email: 'council@x.org', councilRole: 'IntakeManager', status: 'pending' })] });
    expect(sent().Destination?.ToAddresses).toEqual(['council@x.org']);
    expect(sent().Content?.Simple?.Subject?.Data).toBe('Your approval is needed for "Request s1"');
    expect(sent().Content?.Simple?.Body?.Text?.Data).toContain('cadre added you as an approver');
    expect((await env.STORE.list('notifications/id-council/')).objects).toHaveLength(1);
    // The room hears the new gates
    expect((broadcastToSubmissionRoom as jest.Mock).mock.calls.some(([, m]) => m.type === 'approval_state')).toBe(true);
  });

  it('lets Council and Admins change approvers too, but not the submitter or an approver', async () => {
    expect((await setApprovers('council', ['council@x.org'])).status).toBe(200);
    expect((await setApprovers('admin', ['council@x.org', 'ops@x.org'])).status).toBe(200);
    const member = await setApprovers('member', []);
    expect(member.status).toBe(403);
    expect((await stored()).requiredApprovers).toEqual(['council@x.org', 'ops@x.org']);
    await person('lead', 'lead@x.org');
    await putObject('content_submissions/s2', submission('s2', { status: 'in_review', requiredApprovers: ['lead@x.org'] }), env);
    expect((await setApprovers('lead', [], 's2')).status).toBe(403);
  });

  it('refuses bad addresses and sent requests', async () => {
    expect((await setApprovers('cadre', ['not an address'])).status).toBe(400);
    expect((await setApprovers('cadre', 'council@x.org')).status).toBe(400);
    await putObject('content_submissions/s3', submission('s3', { status: 'sent' }), env);
    expect((await setApprovers('cadre', ['council@x.org'], 's3')).status).toBe(409);
  });

  it('puts an approved request back in review when the new council approver has yet to approve', async () => {
    await putObject('content_submissions/s1', submission('s1', {
      status: 'approved', finalApprovalDate: '2026-10-02T00:00:00Z', requiredApprovers: ['council@x.org'],
      approvals: [approve('council', 'council@x.org'), approve('cadre', 'cadre@x.org')],
    }), env);
    const res = await setApprovers('cadre', ['ops@x.org']);
    expect(res.body.submission.status).toBe('in_review');
    expect((await stored()).status).toBe('in_review');
    expect((await stored()).finalApprovalDate).toBeUndefined();
    const changed = (broadcastToSubmissionRoom as jest.Mock).mock.calls.find(([, m]) => m.type === 'status_changed');
    expect(changed[1].data).toMatchObject({ status: 'in_review', previousStatus: 'approved', reason: 'approvers_changed' });
  });

  it('approves once the approvers who are waiting are swapped for ones who approved', async () => {
    await putObject('content_submissions/s1', submission('s1', {
      status: 'in_review', requiredApprovers: ['ops@x.org'],
      approvals: [approve('council', 'council@x.org'), approve('cadre', 'cadre@x.org')],
    }), env);
    const res = await setApprovers('cadre', ['council@x.org']);
    expect(res.body.submission.status).toBe('approved');
    expect(sendSpy).not.toHaveBeenCalled(); // council@ had already approved: nobody new to ask
  });

  it("keeps an override approval when the approvers change", async () => {
    await putObject('content_submissions/s1', submission('s1', { status: 'approved', approvalOverride: true, requiredApprovers: [] }), env);
    expect((await setApprovers('cadre', ['ops@x.org'])).body.submission.status).toBe('approved');
  });

  it('ignores approvers in a general save (a stale copy must not undo a change)', async () => {
    await setApprovers('cadre', ['council@x.org']);
    const res = await call(contentRouter, 'PUT', '/api/content/submissions/s1', 'member', { title: 'New title', requiredApprovers: [] });
    expect(res.status).toBe(200);
    expect(await stored()).toMatchObject({ title: 'New title', requiredApprovers: ['council@x.org'] });
  });

  it('shows the request as waiting on the Comms Cadre until a council approver is listed, then on that council member', async () => {
    const actions = async (who: string) => (await call(contentRouter, 'GET', '/api/content/submissions/my-actions', who)).body;
    const ids = (list: any[]) => list.map((s) => s.id);
    expect(ids((await actions('cadre2')).needsAction)).toContain('s1');
    // A council member who isn't listed isn't asked
    expect(ids((await actions('ops')).needsAction)).not.toContain('s1');

    await setApprovers('cadre', ['council@x.org']);
    expect(ids((await actions('council')).needsAction)).toContain('s1');
    expect(ids((await actions('ops')).needsAction)).not.toContain('s1');
  });
});
