import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
jest.mock('../../src/handlers/websocket', () => ({
  broadcastToSubmissionRoom: jest.fn().mockResolvedValue(undefined),
  broadcastToDocumentRoom: jest.fn().mockResolvedValue(undefined),
}));
import { router as contentRouter } from '../../src/handlers/contentSubmission';
import { createTrackedChangeHandler, updateChangeStatusHandler } from '../../src/handlers/trackedChanges';
import { clearMemoryCache, getObject, listObjects, putObject } from '../../src/services/cacheService';
import { getAskLog } from '../../src/services/workflowNotifications';
import { getUser, saveUser, updateUserNotificationSettings } from '../../src/services/userService';
import { withDerivedAccess } from '../../src/services/access';
import { CreateSession } from '../../src/utils/sessionManager';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

/**
 * Emails and in-app notifications about a request: when it is submitted (approvers and the Comms
 * Cadre), and what happens to it (changes requested, declined, approved, sent) for its submitter.
 * Real storage (in-memory store); SES and the room broadcasts are mocked.
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

async function call(method: string, path: string, who: string, body?: unknown) {
  const res: Response = await contentRouter.fetch(new Request(`http://localhost/api/content${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessions[who]}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env);
  return { status: res.status, body: await res.json().catch(() => null) };
}

function request(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, title: `Request ${id}`, content: lexical('Hello Rangers'), submittedBy: 'id-member', submittedAt: '2026-10-01T00:00:00Z',
    status: 'in_review', formFields: [], comments: [], approvals: [], changes: [], commsCadreApprovals: 0,
    councilManagerApprovals: [], announcementSent: false, assignedCouncilManagers: [], requiredApprovers: [], ...overrides,
  };
}

const approval = (who: string, email: string) => ({
  id: `a-${who}`, submissionId: 's1', approverId: `id-${who}`, approverEmail: email, approverName: who,
  approverType: 'Member', status: 'approved', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
});

const stored = async (id = 's1') => (await getObject<any>(`content_submissions/${id}`, env))!;
const emails = () => sendSpy.mock.calls.map((c) => (c[0] as SendEmailCommand).input);
const to = (address: string) => emails().filter((i) => i.Destination?.ToAddresses?.includes(address));
const subjects = (address: string) => to(address).map((i) => i.Content?.Simple?.Subject?.Data);
const text = (input: any) => input.Content?.Simple?.Body?.Text?.Data as string;
async function inApp(email: string, type?: string) {
  const all = (await Promise.all((await listObjects(`notifications/${email}/`, env)).objects.map((o: any) => getObject<any>(o.key, env))));
  return all.filter((n) => n && (!type || n.type === type));
}

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
  await person('lead', 'lead@x.org');
  await person('member', 'member@x.org');
});

afterEach(() => {
  jest.restoreAllMocks();
});

const newRequest = (who: string, extra: Record<string, unknown> = {}) =>
  call('POST', '/submissions', who, { title: 'Gate shifts', content: lexical('Hello'), status: 'in_review', formFields: [], ...extra });

describe('a request is submitted', () => {
  it('asks the listed approvers and tells the Comms Cadre once, a Cadre approver getting one email', async () => {
    const res = await newRequest('member', { requiredApprovers: ['Council@X.org', 'cadre2@x.org', 'member@x.org'] });
    expect(res.status).toBe(200);
    expect(res.body.submittedNotifiedAt).toBeTruthy();

    expect(emails()).toHaveLength(2);
    // The listed approvers (not the submitter), as one ask
    expect(emails()[0].Destination?.ToAddresses).toEqual(['council@x.org', 'cadre2@x.org']);
    expect(emails()[0].Content?.Simple?.Subject?.Data).toBe('Your approval is needed for "Gate shifts"');
    expect(text(emails()[0])).toContain('member asked you to approve "Gate shifts".');
    // The Comms Cadre who weren't asked as approvers
    expect(emails()[1].Destination?.ToAddresses).toEqual(['cadre@x.org']);
    expect(emails()[1].Content?.Simple?.Subject?.Data).toBe('New request: "Gate shifts"');
    const body = text(emails()[1]);
    expect(body).toContain('member submitted a new request.');
    expect(body).toContain('Open the request: https://scribe.example.org/tracked-changes/');
    expect(body).not.toContain('No council approver');
    expect(to('member@x.org')).toHaveLength(0);

    expect(await inApp('cadre@x.org', 'request_submitted')).toHaveLength(1);
    expect(await inApp('cadre2@x.org', 'request_submitted')).toHaveLength(0);
    expect(await inApp('cadre2@x.org', 'submission_waiting')).toHaveLength(1);
    expect(await inApp('council@x.org', 'submission_waiting')).toHaveLength(1);
    expect(await inApp('member@x.org')).toHaveLength(0);
    expect(Object.keys(await getAskLog(env, res.body.id)).sort()).toEqual(['cadre2@x.org', 'cadre@x.org', 'council@x.org']);
  });

  it('says so when no council approver is listed', async () => {
    await newRequest('member', { requiredApprovers: ['lead@x.org'] });
    expect(emails()).toHaveLength(2);
    expect(emails()[1].Destination?.ToAddresses).toEqual(['cadre@x.org', 'cadre2@x.org']);
    expect(text(emails()[1])).toContain('No council approver is listed yet. Choose one on the review page.');

    sendSpy.mockClear();
    await newRequest('member');
    expect(emails()).toHaveLength(1);
    expect(text(emails()[0])).toContain('No council approver is listed yet.');
  });

  it('never tells the submitter, even when they are on the Comms Cadre', async () => {
    await newRequest('cadre2', { requiredApprovers: ['council@x.org'] });
    expect(to('cadre2@x.org')).toHaveLength(0);
    expect(emails().find((i) => i.Content?.Simple?.Subject?.Data?.startsWith('New request'))?.Destination?.ToAddresses).toEqual(['cadre@x.org']);
  });

  it('says nothing for a draft or a sent request', async () => {
    const draft = await newRequest('member', { status: 'draft' });
    expect(draft.body.submittedNotifiedAt).toBeUndefined();
    await newRequest('member', { status: 'sent' });
    expect(emails()).toHaveLength(0);
  });

  it('tells people once when a draft goes to review, and a client cannot reset it', async () => {
    const id = (await newRequest('member', { status: 'draft', requiredApprovers: ['council@x.org'] })).body.id;
    // A draft saved with the field set doesn't skip the notice
    await call('PUT', `/submissions/${id}`, 'member', { status: 'draft', submittedNotifiedAt: '2020-01-01T00:00:00Z' });
    expect((await stored(id)).submittedNotifiedAt).toBeUndefined();
    expect(emails()).toHaveLength(0);

    const live = await call('PUT', `/submissions/${id}`, 'member', { status: 'in_review' });
    expect(live.status).toBe(200);
    const stamp = (await stored(id)).submittedNotifiedAt;
    expect(stamp).toBeTruthy();
    expect(emails()).toHaveLength(2);

    // Later saves, even back through draft, and a copy with the field removed or changed, say nothing more
    await call('PUT', `/submissions/${id}`, 'member', { title: 'New title', status: 'in_review' });
    await call('PUT', `/submissions/${id}`, 'member', { status: 'draft', submittedNotifiedAt: null });
    await call('PUT', `/submissions/${id}`, 'member', { status: 'submitted', submittedNotifiedAt: '2020-01-01T00:00:00Z' });
    expect((await stored(id)).submittedNotifiedAt).toBe(stamp);
    expect(emails()).toHaveLength(2);
  });

  it('does not tell anyone about an edit to a request that is already live', async () => {
    await putObject('content_submissions/s1', request('s1'), env);
    await call('PUT', '/submissions/s1', 'member', { title: 'Renamed' });
    expect(emails()).toHaveLength(0);
  });

  it('goes only to COMMS_EMAIL_OVERRIDE on dev', async () => {
    env.COMMS_EMAIL_OVERRIDE = 'dev@x.org';
    await newRequest('member', { requiredApprovers: ['council@x.org'] });
    expect(emails().map((i) => i.Destination?.ToAddresses)).toEqual([['dev@x.org'], ['dev@x.org']]);
    expect(emails()[0].Content?.Simple?.Subject?.Data).toBe('[for council@x.org] Your approval is needed for "Gate shifts"');
    expect(emails()[1].Content?.Simple?.Subject?.Data).toBe('[for cadre@x.org, cadre2@x.org] New request: "Gate shifts"');
  });

  it('still creates the request when sending fails', async () => {
    sendSpy.mockImplementation(async () => { throw new Error('SES down'); });
    const res = await newRequest('member', { requiredApprovers: ['council@x.org'] });
    expect(res.status).toBe(200);
    expect((await stored(res.body.id)).title).toBe('Gate shifts');
    expect(await inApp('cadre@x.org', 'request_submitted')).toHaveLength(1);
  });
});

describe('updates for the submitter', () => {
  beforeEach(async () => {
    await putObject('content_submissions/s1', request('s1', { requiredApprovers: ['council@x.org'] }), env);
  });

  it('emails them when changes are requested, with the comment, and notifies once in the app', async () => {
    const res = await call('POST', '/submissions/s1/request-changes', 'cadre', { comment: 'Please add the date' });
    expect(res.status).toBe(200);
    expect(emails()).toHaveLength(1);
    expect(emails()[0].Destination?.ToAddresses).toEqual(['member@x.org']);
    expect(emails()[0].Content?.Simple?.Subject?.Data).toBe('Changes requested on "Request s1"');
    expect(text(emails()[0])).toContain('cadre requested changes on "Request s1".');
    expect(text(emails()[0])).toContain('Please add the date');
    expect(text(emails()[0])).toContain('Open the request: https://scribe.example.org/tracked-changes/s1');
    expect(await inApp('member@x.org')).toHaveLength(1);
    expect(await inApp('member@x.org', 'changes_requested')).toHaveLength(1);
  });

  it("emails them when someone doesn't approve, and an approval stays in the app only", async () => {
    await call('POST', '/submissions/s1/approve', 'council', { status: 'rejected', comment: 'Wrong week' });
    expect(emails()).toHaveLength(1);
    expect(emails()[0].Content?.Simple?.Subject?.Data).toBe(`council didn't approve "Request s1"`);
    expect(text(emails()[0])).toContain('Wrong week');
    expect(await inApp('member@x.org')).toHaveLength(1);
    expect(await inApp('member@x.org', 'rejection_received')).toHaveLength(1);

    sendSpy.mockClear();
    await call('POST', '/submissions/s1/approve', 'council', { status: 'approved' });
    expect(emails()).toHaveLength(0);
    expect(await inApp('member@x.org', 'approval_received')).toHaveLength(1);
  });

  it('emails them when the last approval makes the request approved', async () => {
    await putObject('content_submissions/s1', request('s1', { requiredApprovers: ['council@x.org'], approvals: [approval('council', 'council@x.org')] }), env);
    const res = await call('POST', '/submissions/s1/approve', 'cadre', { status: 'approved' });
    expect(res.status).toBe(200);
    expect((await stored()).status).toBe('approved');
    expect(emails()).toHaveLength(1);
    expect(emails()[0].Destination?.ToAddresses).toEqual(['member@x.org']);
    expect(emails()[0].Content?.Simple?.Subject?.Data).toBe('"Request s1" is approved');
    expect(text(emails()[0])).toContain('The Comms Cadre will send it.');
    expect(await inApp('member@x.org', 'request_approved')).toHaveLength(1);

    // A later approval of an already approved request says nothing
    sendSpy.mockClear();
    await call('POST', '/submissions/s1/approve', 'admin', { status: 'approved' });
    expect(emails()).toHaveLength(0);
  });

  it('says a newsletter-only request goes out in the next Ranger News', async () => {
    await putObject('content_submissions/s1', request('s1', { audiences: ['newsletter'], requiredApprovers: ['council@x.org'], approvals: [approval('council', 'council@x.org')] }), env);
    await call('POST', '/submissions/s1/approve', 'cadre', { status: 'approved' });
    expect(text(emails()[0])).toContain('It will go out in the next Ranger News.');
    expect(text(emails()[0])).not.toContain('The Comms Cadre will send it.');
  });

  it('emails them when the request is approved by an override', async () => {
    const res = await call('POST', '/submissions/s1/override-approve', 'admin', { confirm: true, reason: 'Urgent' });
    expect(res.status).toBe(200);
    expect(emails()).toHaveLength(1);
    expect(emails()[0].Content?.Simple?.Subject?.Data).toBe('"Request s1" is approved');
    // Overriding what is already approved is not news
    sendSpy.mockClear();
    await call('POST', '/submissions/s1/override-approve', 'admin', { confirm: true, reason: 'Again' });
    expect(emails()).toHaveLength(0);
  });

  describe('when the last tracked change is resolved', () => {
    const asUser = async (who: string) => (await getUser(`${who}@x.org`, env))!;
    const req = (user: any, params: Record<string, string>, body: any) => ({ params, user, json: jest.fn().mockResolvedValue(body) }) as any;

    beforeEach(async () => {
      await putObject('content_submissions/s1', request('s1', {
        content: 'Hello world.', requiredApprovers: ['council@x.org'],
        approvals: [approval('council', 'council@x.org'), approval('cadre', 'cadre@x.org')],
      }), env);
    });

    const pendingChange = async () => {
      const res = await createTrackedChangeHandler(
        req(await asUser('lead'), { submissionId: 's1' }, { field: 'content', oldValue: 'Hello world.', newValue: 'Hello there world.' }), env);
      return (await res.json()).id as string;
    };

    it('emails the submitter that it is approved', async () => {
      const changeId = await pendingChange();
      expect((await stored()).status).toBe('in_review');
      expect(emails()).toHaveLength(0);
      await updateChangeStatusHandler(req(await asUser('cadre'), { changeId }, { status: 'approved', submissionId: 's1' }), env);
      expect((await stored()).status).toBe('approved');
      expect(emails()).toHaveLength(1);
      expect(emails()[0].Destination?.ToAddresses).toEqual(['member@x.org']);
      expect(emails()[0].Content?.Simple?.Subject?.Data).toBe('"Request s1" is approved');
      expect(await inApp('member@x.org', 'request_approved')).toHaveLength(1);
    });

    it('says nothing when the submitter resolved it themselves', async () => {
      const changeId = await pendingChange();
      await updateChangeStatusHandler(req(await asUser('member'), { changeId }, { status: 'approved', submissionId: 's1' }), env);
      expect((await stored()).status).toBe('approved');
      expect(emails()).toHaveLength(0);
      expect(await inApp('member@x.org')).toHaveLength(0);
    });
  });

  it('emails them when the announcement is sent, naming the lists, and not again on a resend', async () => {
    await putObject('content_submissions/s1', request('s1', { status: 'approved', audiences: ['singular'] }), env);
    const res = await call('POST', '/submissions/s1/send-email', 'cadre', { listIds: ['announce'] });
    expect(res.status).toBe(200);
    expect(to('announce@example.org')).toHaveLength(1);
    expect(to('member@x.org')).toHaveLength(1);
    expect(subjects('member@x.org')).toEqual(['"Request s1" was sent']);
    expect(text(to('member@x.org')[0])).toContain('"Request s1" was sent to Ranger Announce.');
    expect(await inApp('member@x.org', 'request_sent')).toHaveLength(1);

    env.ALLOW_ANNOUNCEMENT_RESEND = true;
    const again = await call('POST', '/submissions/s1/send-email', 'cadre', { listIds: ['announce'] });
    expect(again.status).toBe(200);
    expect(to('announce@example.org')).toHaveLength(2);
    expect(to('member@x.org')).toHaveLength(1);
    expect(await inApp('member@x.org', 'request_sent')).toHaveLength(1);
  });

  it('emails them when a PUT marks the request sent', async () => {
    await putObject('content_submissions/s1', request('s1', { status: 'approved' }), env);
    await call('PUT', '/submissions/s1', 'cadre', { status: 'sent' });
    expect(subjects('member@x.org')).toEqual(['"Request s1" was sent']);
    // Saving it again, still sent, says nothing more
    await call('PUT', '/submissions/s1', 'cadre', { status: 'sent', title: 'Renamed' });
    expect(to('member@x.org')).toHaveLength(1);
  });

  it('keeps the in-app notification but sends no email when they switched updates off', async () => {
    await updateUserNotificationSettings('id-member', { notifyOnReplies: true, submitterUpdates: false }, env);
    await call('POST', '/submissions/s1/request-changes', 'cadre', { comment: 'Fix it' });
    expect(emails()).toHaveLength(0);
    expect(await inApp('member@x.org', 'changes_requested')).toHaveLength(1);
  });

  it('tells nobody when they did it themselves', async () => {
    await putObject('content_submissions/s2', request('s2', { submittedBy: 'id-cadre', requiredApprovers: ['cadre@x.org'] }), env);
    await call('POST', '/submissions/s2/request-changes', 'cadre', { comment: 'Note to self' });
    await call('POST', '/submissions/s2/approve', 'cadre', { status: 'rejected' });
    expect(emails()).toHaveLength(0);
    expect(await inApp('cadre@x.org')).toHaveLength(0);
  });

  it('goes only to COMMS_EMAIL_OVERRIDE on dev', async () => {
    env.COMMS_EMAIL_OVERRIDE = 'dev@x.org';
    await call('POST', '/submissions/s1/request-changes', 'cadre', { comment: 'Fix it' });
    expect(emails()).toHaveLength(1);
    expect(emails()[0].Destination?.ToAddresses).toEqual(['dev@x.org']);
    expect(emails()[0].Content?.Simple?.Subject?.Data).toBe('[for member@x.org] Changes requested on "Request s1"');
  });

  it('does not fail the request when the email cannot be sent', async () => {
    sendSpy.mockImplementation(async () => { throw new Error('SES down'); });
    const res = await call('POST', '/submissions/s1/request-changes', 'cadre', { comment: 'Fix it' });
    expect(res.status).toBe(200);
    expect(await inApp('member@x.org', 'changes_requested')).toHaveLength(1);
  });
});
