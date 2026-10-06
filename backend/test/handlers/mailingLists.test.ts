import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { router as listsRouter } from '../../src/handlers/mailingLists';
import { router as contentRouter } from '../../src/handlers/contentSubmission';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { saveUser } from '../../src/services/userService';
import { withDerivedAccess } from '../../src/services/access';
import { CreateSession } from '../../src/utils/sessionManager';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

/**
 * Mailing lists (Requests → Settings), sending an approved request to chosen lists, and
 * reminding approvers. SES is mocked.
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
  await person('member', 'member@x.org');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('mailing lists', () => {
  it('the Comms Cadre manage lists; Ranger Announce is built in and fixed', async () => {
    let res = await call(listsRouter, 'POST', '/api/mailing-lists', 'cadre', { name: 'Intake Cadre', address: 'ranger-intake-cadre@burningman.org', audiences: ['jrs', 'bogus'] });
    expect(res.status).toBe(201);
    expect(res.body.list).toMatchObject({ name: 'Intake Cadre', audiences: ['jrs'], active: true });
    const id = res.body.list.id;

    res = await call(listsRouter, 'GET', '/api/mailing-lists', 'council');
    expect(res.body.lists.map((l: any) => l.name)).toEqual(['Ranger Announce', 'Intake Cadre']);
    expect(res.body.canManage).toBe(false);
    expect(res.body.lists[0]).toMatchObject({ id: 'announce', address: 'announce@example.org', builtIn: true });

    expect((await call(listsRouter, 'POST', '/api/mailing-lists', 'council', { name: 'x', address: 'x@y.org' })).status).toBe(403);
    expect((await call(listsRouter, 'GET', '/api/mailing-lists', 'member')).status).toBe(403);
    expect((await call(listsRouter, 'POST', '/api/mailing-lists', 'cadre', { name: 'Bad', address: 'not-an-address' })).status).toBe(400);
    expect((await call(listsRouter, 'POST', '/api/mailing-lists', 'admin', { name: 'Dup', address: 'RANGER-intake-cadre@burningman.org' })).status).toBe(409);
    expect((await call(listsRouter, 'PUT', '/api/mailing-lists/announce', 'admin', { name: 'x' })).status).toBe(400);

    res = await call(listsRouter, 'PUT', `/api/mailing-lists/${id}`, 'admin', { description: 'Intake team', active: false });
    expect(res.body.list).toMatchObject({ description: 'Intake team', active: false, address: 'ranger-intake-cadre@burningman.org' });
    expect((await call(listsRouter, 'DELETE', `/api/mailing-lists/${id}`, 'cadre')).status).toBe(200);
  });
});

describe('sending to mailing lists', () => {
  beforeEach(async () => {
    await call(listsRouter, 'POST', '/api/mailing-lists', 'cadre', { name: 'Allcom', address: 'allcom@burningman.org', audiences: ['allcom'] });
    await call(listsRouter, 'POST', '/api/mailing-lists', 'cadre', { name: 'Intake Cadre', address: 'ranger-intake-cadre@burningman.org', audiences: [] });
  });

  it('suggests the lists for the audience and sends to the ones chosen', async () => {
    await putObject('content_submissions/s1', submission('s1', { audiences: ['allcom'] }), env);
    const preview = await call(contentRouter, 'GET', '/api/content/submissions/s1/email-preview', 'cadre');
    expect(preview.body.lists.map((l: any) => l.name)).toEqual(['Ranger Announce', 'Allcom', 'Intake Cadre']);
    const allcom = preview.body.lists.find((l: any) => l.name === 'Allcom');
    const intake = preview.body.lists.find((l: any) => l.name === 'Intake Cadre');
    expect(preview.body.suggestedListIds).toEqual([allcom.id]);

    const res = await call(contentRouter, 'POST', '/api/content/submissions/s1/send-email', 'cadre', { listIds: [allcom.id, intake.id] });
    expect(res.status).toBe(200);
    expect(sent().Destination?.ToAddresses).toEqual(['allcom@burningman.org', 'ranger-intake-cadre@burningman.org']);
    const stored = await getObject<any>('content_submissions/s1', env);
    expect(stored.sentTo.map((l: any) => l.address)).toEqual(['allcom@burningman.org', 'ranger-intake-cadre@burningman.org']);
    expect(stored.status).toBe('sent');
  });

  it('falls back to Ranger Announce when no list serves the audience, and needs at least one list', async () => {
    await putObject('content_submissions/s2', submission('s2', { audiences: ['singular'] }), env);
    expect((await call(contentRouter, 'POST', '/api/content/submissions/s2/send-email', 'cadre', { listIds: [] })).status).toBe(400);
    expect((await call(contentRouter, 'POST', '/api/content/submissions/s2/send-email', 'cadre', {})).status).toBe(200);
    expect(sent().Destination?.ToAddresses).toEqual(['announce@example.org']);
  });

  it('sends only to COMMS_EMAIL_OVERRIDE on dev, naming the lists in the subject', async () => {
    env.COMMS_EMAIL_OVERRIDE = 'alex@example.org';
    await putObject('content_submissions/s3', submission('s3', { audiences: ['allcom'] }), env);
    await call(contentRouter, 'POST', '/api/content/submissions/s3/send-email', 'cadre', {});
    expect(sent().Destination?.ToAddresses).toEqual(['alex@example.org']);
    expect(sent().Content?.Simple?.Subject?.Data).toBe('[for allcom@burningman.org] Request s3');
  });
});

describe('reminders', () => {
  beforeEach(async () => {
    await putObject('content_submissions/r1', submission('r1', { status: 'in_review', requiredApprovers: ['approver@x.org', 'done@x.org', 'council@x.org'],
      approvals: [{ id: 'a1', submissionId: 'r1', approverId: 'id-done', approverEmail: 'done@x.org', approverName: 'Done', approverType: 'Member', status: 'approved', createdAt: '', updatedAt: '' }] }), env);
    await person('approver', 'approver@x.org');
  });

  it('reminds a required approver who has not approved, once a day', async () => {
    let res = await call(contentRouter, 'POST', '/api/content/submissions/r1/remind', 'cadre', { target: 'approver@x.org' });
    expect(res.status).toBe(200);
    expect(sent().Destination?.ToAddresses).toEqual(['approver@x.org']);
    expect(sent().Content?.Simple?.Subject?.Data).toBe('Reminder: your approval is needed for "Request r1"');
    expect(sent().Content?.Simple?.Body?.Text?.Data).toContain('https://scribe.example.org/tracked-changes/r1');
    expect(res.body.reminder).toMatchObject({ target: 'approver@x.org', to: ['approver@x.org'], by: 'cadre@x.org' });

    res = await call(contentRouter, 'POST', '/api/content/submissions/r1/remind', 'admin', { target: 'approver@x.org' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/try again tomorrow/);
    // Already approved: nothing to remind
    expect((await call(contentRouter, 'POST', '/api/content/submissions/r1/remind', 'cadre', { target: 'done@x.org' })).status).toBe(409);
    // An in-app notification for the approver
    const notes = (await env.STORE.list('notifications/id-approver/')).objects;
    expect(notes).toHaveLength(1);
  });

  it('reminds the Comms Cadre (except the person asking) and the listed council approvers', async () => {
    const res = await call(contentRouter, 'POST', '/api/content/submissions/r1/remind', 'cadre', { target: 'commsCadre' });
    expect(res.status).toBe(200);
    expect(sent().Destination?.ToAddresses).toEqual(['cadre2@x.org']);
    const council = await call(contentRouter, 'POST', '/api/content/submissions/r1/remind', 'cadre', { target: 'council' });
    expect(sent(1).Destination?.ToAddresses).toEqual(['council@x.org']);
    expect(council.body.reminders.map((r: any) => r.target)).toEqual(['commsCadre', 'council']);
    // A listed council approver can be reminded by name too
    expect(sent(1).Content?.Simple?.Subject?.Data).toBe('Reminder: your approval is needed for "Request r1"');
  });

  it("says when there's no council approver to remind yet", async () => {
    await putObject('content_submissions/r3', submission('r3', { status: 'in_review', requiredApprovers: ['approver@x.org'] }), env);
    const res = await call(contentRouter, 'POST', '/api/content/submissions/r3/remind', 'cadre', { target: 'council' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/No council approver chosen yet/);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('is for reviewers and the submitter, and only while waiting for approval', async () => {
    expect((await call(contentRouter, 'POST', '/api/content/submissions/r1/remind', 'approver', { target: 'council' })).status).toBe(403);
    expect((await call(contentRouter, 'POST', '/api/content/submissions/r1/remind', 'member', { target: 'council' })).status).toBe(200);
    await putObject('content_submissions/r2', submission('r2', { status: 'approved' }), env);
    expect((await call(contentRouter, 'POST', '/api/content/submissions/r2/remind', 'cadre', { target: 'council' })).status).toBe(409);
  });

  it('goes only to COMMS_EMAIL_OVERRIDE on dev', async () => {
    env.COMMS_EMAIL_OVERRIDE = 'alex@example.org';
    await call(contentRouter, 'POST', '/api/content/submissions/r1/remind', 'cadre', { target: 'approver@x.org' });
    expect(sent().Destination?.ToAddresses).toEqual(['alex@example.org']);
    expect(sent().Content?.Simple?.Subject?.Data).toMatch(/^\[for approver@x.org\] Reminder/);
  });
});
