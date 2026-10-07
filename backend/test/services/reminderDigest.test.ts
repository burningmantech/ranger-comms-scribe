import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
jest.mock('../../src/handlers/websocket', () => ({
  broadcastToSubmissionRoom: jest.fn().mockResolvedValue(undefined),
  broadcastToDocumentRoom: jest.fn().mockResolvedValue(undefined),
}));
import { router as adminRouter } from '../../src/handlers/admin';
import { clearMemoryCache, getObjectStrict, putObject } from '../../src/services/cacheService';
import { saveUser } from '../../src/services/userService';
import { withDerivedAccess } from '../../src/services/access';
import { CreateSession } from '../../src/utils/sessionManager';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { askForApproval, getAskLog, recordAsked } from '../../src/services/workflowNotifications';
import {
  checkReminderDigest,
  computeDigests,
  pacificDate,
  runReminderDigest,
  startReminderDigestSchedule,
} from '../../src/services/reminderDigest';

/**
 * The daily reminder digest: who is included and when, the email, the ask log, the schedule
 * marker and the admin endpoint. Memory store; SES is mocked.
 */

// Wed Oct 7 2026, 9:00 in Pacific time (PDT, UTC-7)
const MORNING = new Date('2026-10-07T16:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);

let env: any;
let sendSpy: jest.SpyInstance;
const sessions: Record<string, string> = {};

async function person(key: string, email: string, access: Record<string, unknown> = {}) {
  await saveUser(withDerivedAccess({
    id: `id-${key}`, email, name: key, verified: true, groups: [], roles: [],
    userType: 'Member', isAdmin: false, commsCadre: false, councilRole: null, ...access,
  } as any) as any, env);
  sessions[key] = await CreateSession(email, { email }, env);
}

const lexical = (text: string) => JSON.stringify({ root: { type: 'root', version: 1, children: [
  { type: 'paragraph', version: 1, children: [{ type: 'text', version: 1, text, format: 0, style: '', mode: 'normal', detail: 0 }] },
] } });

// Submitted at 15:00 Pacific yesterday: waiting about 18 hours, on an earlier day
const YESTERDAY = '2026-10-06T22:00:00Z';

async function request(id: string, overrides: Record<string, unknown> = {}) {
  await putObject(`content_submissions/${id}`, {
    id, title: `Request ${id}`, content: lexical('Hello'), submittedBy: 'id-member', submittedAt: YESTERDAY,
    status: 'in_review', formFields: [], comments: [], approvals: [], changes: [], commsCadreApprovals: 0,
    councilManagerApprovals: [], announcementSent: false, assignedCouncilManagers: [], requiredApprovers: [], ...overrides,
  }, env);
}

const vote = (who: string, email: string, status: 'approved' | 'rejected') => ({
  id: `v-${who}-${status}`, submissionId: 'x', approverId: `id-${who}`, approverEmail: email, approverName: who,
  approverType: 'Member', status, createdAt: '2026-10-06T23:00:00Z', updatedAt: '2026-10-06T23:00:00Z',
});

const publishBy = (value: string) => [{ id: 'publishBy', label: 'Publish By', type: 'date', value }];

const sent = (i = 0) => (sendSpy.mock.calls[i][0] as SendEmailCommand).input;
const subjects = () => sendSpy.mock.calls.map((c) => (c[0] as SendEmailCommand).input.Content?.Simple?.Subject?.Data);
const recipients = () => sendSpy.mock.calls.map((c) => (c[0] as SendEmailCommand).input.Destination?.ToAddresses?.[0]);
const itemsOf = async (email: string, now = MORNING) => (await computeDigests(env, now)).get(email) || [];

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  clearMemoryCache();
  env = { STORE: new MemoryObjectStore(), FRONTEND_URL: 'https://scribe.example.org' };
  sendSpy = jest.spyOn(SESv2Client.prototype, 'send').mockImplementation(async () => ({ MessageId: 'm', $metadata: {} }) as any);
  await person('admin', 'admin@x.org', { isAdmin: true });
  await person('cadre', 'cadre@x.org', { commsCadre: true });
  await person('cadre2', 'cadre2@x.org', { commsCadre: true });
  await person('council', 'council@x.org', { councilRole: 'IntakeManager' });
  await person('ops', 'ops@x.org', { councilRole: 'OperationsManager' });
  await person('lead', 'lead@x.org');
  await person('member', 'member@x.org');
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('who a request is waiting on', () => {
  it('lists council approvers, other approvers and the Comms Cadre, each with their reason', async () => {
    await request('r1', { requiredApprovers: ['Council@X.org', 'lead@x.org'] });
    const digests = await computeDigests(env, MORNING);
    expect(Array.from(digests.keys()).sort()).toEqual(['cadre2@x.org', 'cadre@x.org', 'council@x.org', 'lead@x.org']);
    expect(digests.get('council@x.org')![0]).toMatchObject({ submissionId: 'r1', title: 'Request r1', reasons: ['Your approval (Council)'], submitterName: 'member', publishBy: null });
    expect(digests.get('lead@x.org')![0].reasons).toEqual(['Your approval']);
    // The council member is listed, so nobody has to choose one
    expect(digests.get('cadre@x.org')![0].reasons).toEqual(['A Comms Cadre approval']);
    expect(digests.get('cadre2@x.org')![0].reasons).toEqual(['A Comms Cadre approval']);
  });

  it('asks the Comms Cadre to choose a council approver when none is listed, merged with their approval', async () => {
    await request('r1', { requiredApprovers: ['lead@x.org'] });
    const digests = await computeDigests(env, MORNING);
    expect(digests.get('cadre@x.org')![0].reasons).toEqual(['A Comms Cadre approval', 'Choose a council approver']);
    expect(digests.get('council@x.org')).toBeUndefined();
  });

  it('merges several reasons for one person, a listed council member who is also Comms Cadre', async () => {
    await person('cm', 'cm@x.org', { commsCadre: true, councilRole: 'CommunicationsManager' });
    await request('r1', { requiredApprovers: ['cm@x.org'] });
    expect(await itemsOf('cm@x.org')).toHaveLength(1);
    expect((await itemsOf('cm@x.org'))[0].reasons).toEqual(['Your approval (Council)', 'A Comms Cadre approval']);
  });

  it('leaves the submitter out of the Comms Cadre items but not out of their own listed approval', async () => {
    await request('r1', { submittedBy: 'id-cadre', requiredApprovers: [] });
    const digests = await computeDigests(env, MORNING);
    expect(digests.get('cadre@x.org')).toBeUndefined();
    expect(digests.get('cadre2@x.org')![0].reasons).toEqual(['A Comms Cadre approval', 'Choose a council approver']);

    await request('r2', { submittedBy: 'id-cadre', requiredApprovers: ['cadre@x.org', 'council@x.org'] });
    expect((await itemsOf('cadre@x.org')).map((i) => [i.submissionId, i.reasons])).toEqual([['r2', ['Your approval']]]);
  });

  it('takes a request off the list of anyone who approved or rejected', async () => {
    await request('r1', {
      requiredApprovers: ['council@x.org', 'ops@x.org', 'lead@x.org'],
      approvals: [vote('council', 'council@x.org', 'approved'), vote('ops', 'ops@x.org', 'rejected')],
    });
    const digests = await computeDigests(env, MORNING);
    expect(digests.get('council@x.org')).toBeUndefined();
    expect(digests.get('ops@x.org')).toBeUndefined();
    expect(digests.get('lead@x.org')).toHaveLength(1);
  });

  it('stops asking the Comms Cadre once one approved, and skips a cadre member who rejected', async () => {
    await request('r1', { requiredApprovers: ['council@x.org'], approvals: [vote('cadre', 'cadre@x.org', 'rejected')] });
    const digests = await computeDigests(env, MORNING);
    expect(digests.get('cadre@x.org')).toBeUndefined();
    expect(digests.get('cadre2@x.org')).toHaveLength(1);

    await request('r2', { requiredApprovers: ['council@x.org'], approvals: [vote('cadre', 'cadre@x.org', 'approved')] });
    expect((await itemsOf('cadre2@x.org')).map((i) => i.submissionId)).toEqual(['r1']);
  });

  it('only counts submitted and in review requests', async () => {
    for (const status of ['draft', 'approved', 'sent', 'rejected']) {
      await request(`s-${status}`, { status, requiredApprovers: ['lead@x.org'] });
    }
    await request('open', { status: 'submitted', requiredApprovers: ['lead@x.org'] });
    expect((await itemsOf('lead@x.org')).map((i) => i.submissionId)).toEqual(['open']);
  });
});

describe('when a request goes in', () => {
  const ago = (ms: number) => new Date(MORNING.getTime() - ms).toISOString();
  const HOUR = 60 * 60 * 1000;

  it('needs 12 hours of waiting and an earlier Pacific day', async () => {
    // 8 hours: too soon, even though it is yesterday in UTC
    await request('soon', { requiredApprovers: ['lead@x.org'], submittedAt: '2026-10-07T08:00:00Z' });
    // 11 hours, 22:00 yesterday Pacific: an earlier day but under 12 hours
    await request('eleven', { requiredApprovers: ['lead@x.org'], submittedAt: '2026-10-07T05:00:00Z' });
    // 13 hours, 20:00 yesterday Pacific
    await request('thirteen', { requiredApprovers: ['lead@x.org'], submittedAt: '2026-10-07T03:00:00Z' });
    expect((await itemsOf('lead@x.org')).map((i) => i.submissionId)).toEqual(['thirteen']);
  });

  it('leaves out a request that has waited 12 hours but all on today (Pacific)', async () => {
    await request('r1', { requiredApprovers: ['lead@x.org'], submittedAt: '2026-10-07T07:30:00Z' }); // 00:30 Pacific
    const evening = new Date('2026-10-07T23:00:00Z'); // 16:00 Pacific: 15.5 hours later
    expect(await itemsOf('lead@x.org', evening)).toEqual([]);
    // The next morning it is on an earlier day
    expect((await itemsOf('lead@x.org', plus(MORNING, DAY))).map((i) => i.submissionId)).toEqual(['r1']);
  });

  it('counts days in Pacific time, not UTC', () => {
    expect(pacificDate(new Date('2026-10-07T06:59:00Z'))).toBe('2026-10-06');
    expect(pacificDate(new Date('2026-10-07T07:00:00Z'))).toBe('2026-10-07');
    expect(pacificDate(new Date('2026-12-07T07:59:00Z'))).toBe('2026-12-06');
  });

  it('holds a request back until a day after the last ask, but shows the wait from the first', async () => {
    await request('r1', { requiredApprovers: ['lead@x.org', 'council@x.org'] });
    // First asked the afternoon before: in the digest, waiting since then
    await recordAsked(env, 'r1', ['Lead@x.org'], '2026-10-06T21:00:00Z');
    const item = (await itemsOf('lead@x.org'))[0];
    expect(item.waitingSince).toBe('2026-10-06T21:00:00.000Z');
    // Reminded two hours ago: too soon, though the first ask was yesterday
    await recordAsked(env, 'r1', ['lead@x.org'], ago(2 * HOUR));
    expect(await itemsOf('lead@x.org')).toEqual([]);
    expect((await itemsOf('council@x.org')).map((i) => i.submissionId)).toEqual(['r1']);
  });

  it('sorts by the first ask, not the last', async () => {
    await request('a', { requiredApprovers: ['lead@x.org'], submittedAt: '2026-10-01T20:00:00Z' });
    await request('b', { requiredApprovers: ['lead@x.org'], submittedAt: '2026-10-02T20:00:00Z' });
    await recordAsked(env, 'a', ['lead@x.org'], '2026-10-03T20:00:00Z');
    await recordAsked(env, 'a', ['lead@x.org'], '2026-10-06T20:00:00Z');
    await recordAsked(env, 'b', ['lead@x.org'], '2026-10-04T20:00:00Z');
    expect((await itemsOf('lead@x.org')).map((i) => [i.submissionId, i.waitingSince])).toEqual([
      ['a', '2026-10-03T20:00:00.000Z'],
      ['b', '2026-10-04T20:00:00.000Z'],
    ]);
  });

  it('sorts by Publish By, none last, then the longest waiting first', async () => {
    await request('none', { requiredApprovers: ['lead@x.org'] });
    await request('late', { requiredApprovers: ['lead@x.org'], formFields: publishBy('2026-10-20') });
    await request('soon-newer', { requiredApprovers: ['lead@x.org'], formFields: publishBy('2026-10-09'), submittedAt: '2026-10-06T23:00:00Z' });
    await request('soon-older', { requiredApprovers: ['lead@x.org'], formFields: publishBy('2026-10-09'), submittedAt: '2026-10-05T20:00:00Z' });
    await request('none-older', { requiredApprovers: ['lead@x.org'], submittedAt: '2026-10-04T20:00:00Z' });
    expect((await itemsOf('lead@x.org')).map((i) => i.submissionId)).toEqual(['soon-older', 'soon-newer', 'late', 'none-older', 'none']);
  });
});

describe('sending the digest', () => {
  it('sends one email per person listing every request, in order', async () => {
    await request('a', { title: 'Burn night shifts', requiredApprovers: ['lead@x.org'], formFields: publishBy('2026-10-09') });
    await request('b', { title: 'Camp reminders', requiredApprovers: ['lead@x.org'], formFields: publishBy('2026-10-06'), submittedAt: '2026-10-05T20:00:00Z' });
    await request('c', { title: 'No date', requiredApprovers: ['lead@x.org'] });

    const summary = await runReminderDigest(env, { now: MORNING });
    expect(summary).toMatchObject({ date: '2026-10-07', dryRun: false, sent: 3, failed: 0 });
    expect(summary.recipients).toEqual([
      { email: 'cadre@x.org', count: 3, titles: ['Camp reminders', 'Burn night shifts', 'No date'] },
      { email: 'cadre2@x.org', count: 3, titles: ['Camp reminders', 'Burn night shifts', 'No date'] },
      { email: 'lead@x.org', count: 3, titles: ['Camp reminders', 'Burn night shifts', 'No date'] },
    ]);
    expect(sendSpy).toHaveBeenCalledTimes(3);
    const lead = sendSpy.mock.calls.map((c) => (c[0] as SendEmailCommand).input).find((i) => i.Destination?.ToAddresses?.[0] === 'lead@x.org')!;
    expect(lead.Content?.Simple?.Subject?.Data).toBe('3 requests are waiting on you');
    const text = lead.Content?.Simple?.Body?.Text?.Data!;
    expect(text).toContain("Here's what's waiting on you in Comms Scribe.");
    expect(text.indexOf('Camp reminders')).toBeLessThan(text.indexOf('Burn night shifts'));
    expect(text.indexOf('Burn night shifts')).toBeLessThan(text.indexOf('No date'));
    expect(text).toContain('Your approval\n');
    expect(text).toContain('Submitted by member');
    expect(text).toContain('Publish by Tue, Oct 6 (overdue)');
    expect(text).toContain('Publish by Fri, Oct 9 (in 2 days)');
    expect(text).toContain('Waiting since Mon, Oct 5');
    expect(text).toContain('Waiting since Tue, Oct 6');
    expect(text).toContain('https://scribe.example.org/tracked-changes/a');
    expect(text).toContain('daily reminder');
    expect(lead.Content?.Simple?.Body?.Html?.Data).toContain('href="https://scribe.example.org/tracked-changes/b"');
  });

  it('names the request when there is only one, and says today and tomorrow', async () => {
    await request('a', { title: 'Burn night shifts', requiredApprovers: ['council@x.org'], formFields: publishBy('2026-10-07') });
    await runReminderDigest(env, { now: MORNING });
    const council = sendSpy.mock.calls.map((c) => (c[0] as SendEmailCommand).input).find((i) => i.Destination?.ToAddresses?.[0] === 'council@x.org')!;
    expect(council.Content?.Simple?.Subject?.Data).toBe('"Burn night shifts" is waiting on you');
    expect(council.Content?.Simple?.Body?.Text?.Data).toContain('Your approval (Council)');
    expect(council.Content?.Simple?.Body?.Text?.Data).toContain('Publish by Wed, Oct 7 (today)');
    await putObject('content_submissions/a', { ...(await getObjectStrict<any>('content_submissions/a', env)), formFields: publishBy('2026-10-08') }, env);
    sendSpy.mockClear();
    await runReminderDigest(env, { now: plus(MORNING, DAY) });
    const next = sendSpy.mock.calls.map((c) => (c[0] as SendEmailCommand).input).find((i) => i.Destination?.ToAddresses?.[0] === 'council@x.org')!;
    expect(next.Content?.Simple?.Body?.Text?.Data).toContain('Publish by Thu, Oct 8 (today)');
  });

  it('does not change the ask log, and lists the request on consecutive mornings with the same wait', async () => {
    await request('a', { requiredApprovers: ['lead@x.org'] });
    await runReminderDigest(env, { now: MORNING });
    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(await getAskLog(env, 'a')).toEqual({});

    sendSpy.mockClear();
    await runReminderDigest(env, { now: plus(MORNING, DAY) });
    await runReminderDigest(env, { now: plus(MORNING, 2 * DAY) });
    expect(sendSpy).toHaveBeenCalledTimes(6);
    for (const call of sendSpy.mock.calls) {
      const input = (call[0] as SendEmailCommand).input;
      expect(input.Content?.Simple?.Body?.Text?.Data).toContain('Waiting since Tue, Oct 6');
    }
    expect(await getAskLog(env, 'a')).toEqual({});
  });

  it('leaves out someone who was reminded by hand this morning, and keeps them in from the next day', async () => {
    await request('a', { submittedBy: 'id-member', requiredApprovers: ['lead@x.org', 'council@x.org'] });
    const reminder = { id: 'id-cadre', email: 'cadre@x.org', name: 'cadre' } as any;
    // 7am Pacific today, with the submission's own ask clock
    jest.useFakeTimers({ now: new Date('2026-10-07T14:00:00Z') });
    await askForApproval((await getObjectStrict<any>('content_submissions/a', env))!, ['lead@x.org'], reminder, 'reminder', env);
    jest.useRealTimers();
    sendSpy.mockClear();
    await runReminderDigest(env, { now: MORNING });
    expect(recipients()).not.toContain('lead@x.org');
    expect(recipients()).toContain('council@x.org');
    // The next morning: waiting since the first ask (today's reminder)
    sendSpy.mockClear();
    await runReminderDigest(env, { now: plus(MORNING, DAY) });
    expect(recipients()).toContain('lead@x.org');
  });

  it('adds one in-app notification per person, linking to the requests', async () => {
    await request('a', { title: 'Burn night shifts', requiredApprovers: ['lead@x.org'] });
    await runReminderDigest(env, { now: MORNING });
    const listed = (await env.STORE.list('notifications/lead@x.org/')).objects;
    expect(listed).toHaveLength(1);
    const note = await (await env.STORE.get(listed[0].key)).json();
    expect(note).toMatchObject({ userId: 'lead@x.org', type: 'reminder_digest', title: '"Burn night shifts" is waiting on you', link: '/requests', read: false });
  });

  it('sends nothing and records nothing on a dry run', async () => {
    await request('a', { requiredApprovers: ['lead@x.org'] });
    const summary = await runReminderDigest(env, { now: MORNING, dryRun: true });
    expect(summary).toMatchObject({ dryRun: true, sent: 0, failed: 0 });
    expect(summary.recipients.map((r) => r.email)).toEqual(['cadre@x.org', 'cadre2@x.org', 'lead@x.org']);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await getAskLog(env, 'a')).toEqual({});
    expect((await env.STORE.list('notifications/')).objects).toHaveLength(0);
  });

  it('goes on after a failure for one person', async () => {
    await request('a', { requiredApprovers: ['lead@x.org'] });
    sendSpy.mockImplementation(async (cmd: any) => {
      if (cmd.input.Destination.ToAddresses[0] === 'cadre@x.org') throw new Error('Throttled');
      return { MessageId: 'm', $metadata: {} } as any;
    });
    const summary = await runReminderDigest(env, { now: MORNING });
    expect(summary).toMatchObject({ sent: 2, failed: 1 });
    expect(recipients().sort()).toEqual(['cadre2@x.org', 'cadre@x.org', 'lead@x.org']);
  });

  it('sends only to COMMS_EMAIL_OVERRIDE on dev, with the real recipient in the subject', async () => {
    env.COMMS_EMAIL_OVERRIDE = 'alex@dev.example.org';
    await request('a', { title: 'Burn night shifts', requiredApprovers: ['council@x.org'] });
    await runReminderDigest(env, { now: MORNING });
    expect(recipients().every((to) => to === 'alex@dev.example.org')).toBe(true);
    expect(subjects()).toContain('[for council@x.org] "Burn night shifts" is waiting on you');
  });
});

describe('the schedule', () => {
  const marker = () => getObjectStrict<any>('jobs/reminder-digest', env);
  const at = (iso: string) => new Date(iso);

  beforeEach(() => request('a', { requiredApprovers: ['lead@x.org'] }));

  it('does nothing before 8am Pacific', async () => {
    expect(await checkReminderDigest(env, at('2026-10-07T14:59:00Z'))).toBeNull(); // 7:59
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await marker()).toBeNull();
  });

  it('runs once a Pacific day, from 8am', async () => {
    const first = await checkReminderDigest(env, at('2026-10-07T15:00:00Z')); // 8:00
    expect(first).toMatchObject({ date: '2026-10-07', sent: 3 });
    expect(await marker()).toMatchObject({ lastRunDate: '2026-10-07', summary: { sent: 3 } });
    sendSpy.mockClear();

    // Another check that day, even with new requests waiting, does nothing
    await request('b', { requiredApprovers: ['lead@x.org'], submittedAt: '2026-10-05T20:00:00Z' });
    expect(await checkReminderDigest(env, at('2026-10-07T20:00:00Z'))).toBeNull();
    expect(sendSpy).not.toHaveBeenCalled();

    // After midnight Pacific it is a new day, but not before 8
    expect(await checkReminderDigest(env, at('2026-10-08T08:00:00Z'))).toBeNull(); // 1:00 on the 8th
    expect(await checkReminderDigest(env, at('2026-10-08T15:30:00Z'))).toMatchObject({ date: '2026-10-08' });
    expect((await marker()).lastRunDate).toBe('2026-10-08');
  });

  it('writes the marker before sending, so a restart cannot send twice', async () => {
    let markerWhenSending: any = 'unset';
    sendSpy.mockImplementation(async () => {
      if (markerWhenSending === 'unset') markerWhenSending = await marker();
      return { MessageId: 'm', $metadata: {} } as any;
    });
    await checkReminderDigest(env, at('2026-10-07T16:00:00Z'));
    expect(markerWhenSending).toMatchObject({ lastRunDate: '2026-10-07' });
    expect(markerWhenSending.summary).toBeUndefined();
  });

  it('does not run again when the marker already holds today, and not on a failed run', async () => {
    await putObject('jobs/reminder-digest', { lastRunDate: '2026-10-07', startedAt: '2026-10-07T15:00:00Z' }, env);
    expect(await checkReminderDigest(env, at('2026-10-07T16:00:00Z'))).toBeNull();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('is off when REMINDER_DIGEST is off', async () => {
    env.REMINDER_DIGEST = 'off';
    expect(await checkReminderDigest(env, at('2026-10-07T16:00:00Z'))).toBeNull();
    expect(sendSpy).not.toHaveBeenCalled();
    const stop = startReminderDigestSchedule(env, { firstCheckMs: 1, everyMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await marker()).toBeNull();
  });

  it('checks on its timers with the injected clock', async () => {
    jest.useFakeTimers();
    let now = at('2026-10-07T14:00:00Z'); // 7:00
    const stop = startReminderDigestSchedule(env, { clock: () => now, firstCheckMs: 1000, everyMs: 60 * 60 * 1000 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(sendSpy).not.toHaveBeenCalled();
    now = at('2026-10-07T15:10:00Z'); // 8:10
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendSpy).toHaveBeenCalledTimes(3);
    sendSpy.mockClear();
    now = at('2026-10-07T16:10:00Z');
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(sendSpy).not.toHaveBeenCalled();
    stop();
  });
});

describe('POST /api/admin/reminder-digest', () => {
  const call = (who: string | null, body?: unknown) =>
    adminRouter.fetch(new Request('http://localhost/api/admin/reminder-digest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${sessions[who]}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), env) as Promise<Response>;

  beforeEach(() => request('a', { requiredApprovers: ['lead@x.org'] }));

  it('is for Admins only', async () => {
    for (const who of ['cadre', 'council', 'member']) expect((await call(who, {})).status).toBe(403);
    expect((await call(null, {})).status).toBeGreaterThanOrEqual(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('is a dry run by default and returns the summary', async () => {
    const res = await call('admin');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.dryRun).toBe(true);
    expect(body.sent).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
    const explicit: any = await (await call('admin', { dryRun: true })).json();
    expect(explicit.dryRun).toBe(true);
  });

  it('sends when dryRun is false, and refuses another value', async () => {
    expect((await call('admin', { dryRun: 'no' })).status).toBe(400);
    const res = await call('admin', { dryRun: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: false });
    expect(sendSpy.mock.calls.length).toBeGreaterThan(0);
  });
});
