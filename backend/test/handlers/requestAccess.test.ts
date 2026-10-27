import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SESv2Client } from '@aws-sdk/client-sesv2';
jest.mock('../../src/handlers/websocket', () => ({
  recheckRoomAccess: jest.fn().mockResolvedValue(0),
  broadcastToSubmissionRoom: jest.fn().mockResolvedValue(undefined),
  broadcastToDocumentRoom: jest.fn().mockResolvedValue(undefined),
}));
import { router as contentRouter } from '../../src/handlers/contentSubmission';
import { router as notificationsRouter } from '../../src/handlers/notifications';
import { updateProposedVersionsHandler, getTrackedChangesHandler, createTrackedChangeHandler } from '../../src/handlers/trackedChanges';
import { router as pageRouter } from '../../src/handlers/page';
import { getTimelineHandler } from '../../src/handlers/timeline';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { getUser, saveUser } from '../../src/services/userService';
import { withDerivedAccess } from '../../src/services/access';
import { CreateSession } from '../../src/utils/sessionManager';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

/**
 * Who may read and change a request: what a signed-in person who isn't on it can't do, what a
 * PUT body can't set, and that an approver's address only counts once it is proven.
 */

let env: any;
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

async function call(method: string, path: string, who: string, body?: unknown) {
  const res: Response = await contentRouter.fetch(new Request(`http://localhost/api/content${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessions[who]}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const asUser = async (who: string) => (await getUser(`${who}@x.org`, env))!;
const req = (user: any, params: Record<string, string>, body: any = {}) => ({ params, user, json: jest.fn().mockResolvedValue(body) }) as any;

function request(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, title: `Request ${id}`, content: 'Hello Rangers', richTextContent: lexical('Hello Rangers'),
    submittedBy: 'id-member', submittedAt: '2026-10-01T00:00:00Z',
    status: 'in_review', formFields: [], comments: [], approvals: [], changes: [], commsCadreApprovals: 0,
    councilManagerApprovals: [], announcementSent: false, assignedCouncilManagers: [], requiredApprovers: ['approver@x.org'], ...overrides,
  };
}
const stored = async (id = 's1') => (await getObject<any>(`content_submissions/${id}`, env))!;

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(SESv2Client.prototype, 'send').mockImplementation(async () => ({ MessageId: 'm', $metadata: {} }) as any);
  clearMemoryCache();
  env = { STORE: new MemoryObjectStore(), FRONTEND_URL: 'https://scribe.example.org' };
  await person('cadre', 'cadre@x.org', { commsCadre: true });
  await person('member', 'member@x.org');
  await person('approver', 'approver@x.org');
  await person('outsider', 'outsider@x.org');
  await putObject('content_submissions/s1', request('s1'), env);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('someone not on the request', () => {
  it("doesn't see it in my-actions", async () => {
    const res = await call('GET', '/submissions/my-actions', 'outsider');
    expect(res.status).toBe(200);
    expect([...res.body.needsAction, ...res.body.inProgress].map((s: any) => s.id)).toEqual([]);
    const listed = await call('GET', '/submissions/my-actions', 'approver');
    expect(listed.body.needsAction.map((s: any) => s.id)).toEqual(['s1']);
  });

  it("can't comment on it", async () => {
    expect((await call('POST', '/submissions/s1/comments', 'outsider', { content: 'hi' })).status).toBe(403);
    expect((await stored()).comments).toHaveLength(0);
  });

  it("can't read or add its tracked changes, or read its timeline", async () => {
    const outsider = await asUser('outsider');
    expect((await getTrackedChangesHandler(req(outsider, { submissionId: 's1' }), env)).status).toBe(403);
    expect((await createTrackedChangeHandler(req(outsider, { submissionId: 's1' }, { field: 'content', oldValue: 'a', newValue: 'b' }), env)).status).toBe(403);
    expect((await getTimelineHandler(req(outsider, { submissionId: 's1' }), env)).status).toBe(403);
    expect((await getTrackedChangesHandler(req(await asUser('approver'), { submissionId: 's1' }), env)).status).toBe(200);
  });

  it("can't replace the proposed document", async () => {
    const res = await updateProposedVersionsHandler(req(await asUser('outsider'), { submissionId: 's1' }, { proposedVersionsRichText: lexical('Defaced') }), env);
    expect(res.status).toBe(403);
    expect(await getObject('proposed_versions/s1', env)).toBeNull();
  });
});

describe('the proposed document', () => {
  it('is saved by the submitter while in review', async () => {
    const res = await updateProposedVersionsHandler(req(await asUser('member'), { submissionId: 's1' }, { proposedVersionsRichText: lexical('Edit') }), env);
    expect(res.status).toBe(200);
  });

  it('is not changed by the submitter once approved, nor by anyone once sent', async () => {
    await putObject('content_submissions/s1', request('s1', { status: 'approved' }), env);
    expect((await updateProposedVersionsHandler(req(await asUser('member'), { submissionId: 's1' }, { proposedVersionsRichText: lexical('x') }), env)).status).toBe(403);
    expect((await updateProposedVersionsHandler(req(await asUser('cadre'), { submissionId: 's1' }, { proposedVersionsRichText: lexical('x') }), env)).status).toBe(200);
    await putObject('content_submissions/s1', request('s1', { status: 'sent' }), env);
    expect((await updateProposedVersionsHandler(req(await asUser('cadre'), { submissionId: 's1' }, { proposedVersionsRichText: lexical('x') }), env)).status).toBe(409);
  });
});

describe('PUT /submissions/:id', () => {
  it("can't approve, send or take over a request", async () => {
    const res = await call('PUT', '/submissions/s1', 'member', {
      status: 'approved', submittedBy: 'id-other', id: 'other', approvalOverride: true, finalApprovalDate: '2026-10-02',
    });
    expect(res.status).toBe(200);
    const s = await stored();
    expect(s).toMatchObject({ id: 's1', status: 'in_review', submittedBy: 'id-member' });
    expect(s.approvalOverride).toBeUndefined();
    expect(s.finalApprovalDate).toBeUndefined();
    await call('PUT', '/submissions/s1', 'approver', { status: 'sent' });
    expect((await stored()).status).toBe('in_review');
  });

  it('sends a draft for review', async () => {
    await putObject('content_submissions/s1', request('s1', { status: 'draft' }), env);
    await call('PUT', '/submissions/s1', 'member', { status: 'in_review' });
    expect((await stored()).status).toBe('in_review');
  });

  it("keeps an approved request's message from the submitter, and lets the Comms Cadre mark it sent", async () => {
    await putObject('content_submissions/s1', request('s1', { status: 'approved' }), env);
    await call('PUT', '/submissions/s1', 'member', { title: 'Something else', content: 'Changed' });
    expect(await stored()).toMatchObject({ title: 'Request s1', content: 'Hello Rangers', status: 'approved' });
    await call('PUT', '/submissions/s1', 'cadre', { status: 'sent', sentAt: '2026-10-03' });
    expect(await stored()).toMatchObject({ status: 'sent', sentBy: 'cadre@x.org', sentAt: '2026-10-03T00:00:00.000Z' });
  });
});

describe('a sent request', () => {
  it("keeps its message even from the Comms Cadre (what went out doesn't change)", async () => {
    await putObject('content_submissions/s1', request('s1', { status: 'sent' }), env);
    await call('PUT', '/submissions/s1', 'cadre', { title: 'Rewritten', content: 'Rewritten' });
    expect(await stored()).toMatchObject({ title: 'Request s1', content: 'Hello Rangers', status: 'sent' });
  });
});

describe('POST /submissions', () => {
  it('creates only drafts or requests in review, with real approver addresses', async () => {
    const res = await call('POST', '/submissions', 'member', { title: 'T', content: 'C', status: 'approved', formFields: [] });
    expect(res.body.status).toBe('draft');
    expect((await call('POST', '/submissions', 'member', { title: 'T', content: 'C', status: 'in_review', formFields: [] })).body.status).toBe('in_review');
    expect((await call('POST', '/submissions', 'member', { title: 'T', content: 'C', requiredApprovers: ['not an address'] })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `p${i}@x.org`);
    expect((await call('POST', '/submissions', 'member', { title: 'T', content: 'C', requiredApprovers: many })).status).toBe(400);
  });
});

describe('POST /submissions/:id/approve', () => {
  it('takes only approved or rejected', async () => {
    expect((await call('POST', '/submissions/s1/approve', 'approver', { status: 'sent' })).status).toBe(400);
    expect((await call('POST', '/submissions/s1/approve', 'approver', { status: 'approved' })).status).toBe(200);
  });

  it("doesn't count an unverified account for a listed address", async () => {
    await saveUser({ ...(await asUser('approver')), verified: false } as any, env);
    expect((await call('POST', '/submissions/s1/approve', 'approver', { status: 'approved' })).status).toBe(403);
    expect((await call('GET', '/submissions/s1', 'approver')).status).toBe(403);
  });
});

describe('override-approve', () => {
  it('leaves a sent request alone', async () => {
    await person('admin', 'admin@x.org', { isAdmin: true });
    await putObject('content_submissions/s1', request('s1', { status: 'sent' }), env);
    expect((await call('POST', '/submissions/s1/override-approve', 'admin', { confirm: true, reason: 'again' })).status).toBe(409);
    expect((await stored()).status).toBe('sent');
  });
});

describe('the page list', () => {
  it('shows non-public pages only to Admins', async () => {
    await person('admin', 'admin@x.org', { isAdmin: true });
    await putObject('page/p1', { id: 'p1', title: 'Public', slug: 'public', content: '', published: true, isPublic: true, order: 1 }, env);
    await putObject('page/p2', { id: 'p2', title: 'Private', slug: 'private', content: '', published: true, isPublic: false, order: 2 }, env);
    const list = async (who: string) => {
      const request = new Request('http://localhost/api/page/');
      (request as any).user = await getUser(`${who}@x.org`, env); // as withOptionalSession sets it
      return ((await (await pageRouter.fetch(request, env)).json()) as any[]).map((p) => p.id);
    };
    expect(await list('member')).toEqual(['p1']);
    expect(await list('admin')).toEqual(['p1', 'p2']);
  });
});

describe('request-changes', () => {
  it('leaves a sent request alone', async () => {
    await putObject('content_submissions/s1', request('s1', { status: 'sent' }), env);
    expect((await call('POST', '/submissions/s1/request-changes', 'cadre', { comment: 'redo' })).status).toBe(409);
    expect((await stored()).status).toBe('sent');
  });
});

describe('the in-app inbox', () => {
  it('stays closed to an unverified account', async () => {
    await putObject('notifications/approver@x.org/n1', { id: 'n1', title: 'Your approval is needed', read: false, createdAt: '2026-10-02T00:00:00Z' }, env);
    const inbox = async () => (await (await notificationsRouter.fetch(new Request('http://localhost/api/notifications/', {
      headers: { Authorization: `Bearer ${sessions.approver}` },
    }), env)).json()).notifications;
    expect(await inbox()).toHaveLength(1);
    await saveUser({ ...(await asUser('approver')), verified: false } as any, env);
    expect(await inbox()).toHaveLength(0);
  });
});
