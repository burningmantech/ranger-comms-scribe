import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { clearMemoryCache, getObject, listObjects } from '../../src/services/cacheService';
import { askForApproval, getAskLog, notifyRequestSubmitted, recordAsked } from '../../src/services/workflowNotifications';
import { createInAppNotification } from '../../src/services/notificationService';
import { updateUserNotificationSettings, wantsSubmitterUpdates, getUserNotificationSettings } from '../../src/services/userService';

let env: any;
let sendSpy: jest.SpyInstance;

const user = (email: string, extra: Record<string, unknown> = {}) => ({ id: `id-${email.split('@')[0]}`, email, name: email.split('@')[0], ...extra });

async function putUser(u: any) {
  await env.STORE.put(`user/${u.email}`, JSON.stringify(u));
  await env.STORE.put(`user-by-id/${u.id}`, JSON.stringify({ email: u.email }));
}

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  clearMemoryCache();
  env = { STORE: new MemoryObjectStore(), FRONTEND_URL: 'https://scrivenly.com' };
  sendSpy = jest
    .spyOn(SESv2Client.prototype, 'send')
    .mockImplementation(async () => ({ MessageId: 'id', $metadata: {} }) as any);
  await putUser(user('sam@x.org'));
  await putUser(user('pat@x.org'));
});

afterEach(() => {
  jest.restoreAllMocks();
});

const submission: any = { id: 's1', title: 'Gate shifts', submittedBy: 'id-sam', formFields: [], status: 'in_review' };

describe('in-app notification keys', () => {
  it('stores under the lowercased email whether given an email or a user id', async () => {
    const byEmail = await createInAppNotification({ userId: 'Sam@X.org', type: 'submission_waiting', title: 'T', message: 'M' }, env);
    const byId = await createInAppNotification({ userId: 'id-pat', type: 'submission_waiting', title: 'T', message: 'M' }, env);

    expect(byEmail?.userId).toBe('sam@x.org');
    expect(byId?.userId).toBe('pat@x.org');
    expect(await getObject<any>(`notifications/sam@x.org/${byEmail!.id}`, env)).toMatchObject({ userId: 'sam@x.org' });
    expect(await getObject<any>(`notifications/pat@x.org/${byId!.id}`, env)).toMatchObject({ userId: 'pat@x.org' });
  });

  it('returns null and stores nothing for an unknown user id', async () => {
    const result = await createInAppNotification({ userId: 'nobody', type: 'submission_waiting', title: 'T', message: 'M' }, env);
    expect(result).toBeNull();
    expect((await listObjects('notifications/', env)).objects).toHaveLength(0);
  });
});

describe('ask log', () => {
  it('records and merges lowercased emails', async () => {
    await recordAsked(env, 's1', ['Sam@x.org'], '2026-10-01T00:00:00.000Z');
    await recordAsked(env, 's1', ['pat@x.org', 'sam@x.org'], '2026-10-05T00:00:00.000Z');
    await recordAsked(env, 's2', ['lee@x.org'], '2026-10-06T00:00:00.000Z');

    // The first ask is kept, the last is the latest
    expect(await getAskLog(env, 's1')).toEqual({
      'sam@x.org': { first: '2026-10-01T00:00:00.000Z', last: '2026-10-05T00:00:00.000Z' },
      'pat@x.org': { first: '2026-10-05T00:00:00.000Z', last: '2026-10-05T00:00:00.000Z' },
    });
    expect(await getAskLog(env, 's2')).toEqual({ 'lee@x.org': { first: '2026-10-06T00:00:00.000Z', last: '2026-10-06T00:00:00.000Z' } });
    expect(await getAskLog(env, 'none')).toEqual({});
  });

  it('keeps every entry when asks run at the same time', async () => {
    await Promise.all(['a@x.org', 'b@x.org', 'c@x.org'].map((e) => recordAsked(env, 's1', [e])));
    expect(Object.keys(await getAskLog(env, 's1')).sort()).toEqual(['a@x.org', 'b@x.org', 'c@x.org']);
  });

  it('never throws when the store fails', async () => {
    env.STORE.put = async () => { throw new Error('S3 down'); };
    await expect(recordAsked(env, 's1', ['a@x.org'])).resolves.toBeUndefined();
  });
});

describe('askForApproval', () => {
  const actor: any = user('lee@x.org', { name: 'Lee Cadre' });

  it('sends one email to everyone, notifies each in the app and records the ask', async () => {
    await askForApproval(submission, ['sam@x.org', 'pat@x.org'], actor, 'added', env);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const input = (sendSpy.mock.calls[0][0] as SendEmailCommand).input;
    expect(input.Destination?.ToAddresses).toEqual(['sam@x.org', 'pat@x.org']);
    expect(input.Content?.Simple?.Subject?.Data).toBe('Your approval is needed for "Gate shifts"');
    expect(input.Content?.Simple?.Body?.Text?.Data).toContain('Lee Cadre added you as an approver of "Gate shifts".');
    expect(input.Content?.Simple?.Body?.Html?.Data).toContain('Open the request');
    expect(input.Content?.Simple?.Body?.Html?.Data).toContain('https://scrivenly.com/tracked-changes/s1');

    for (const email of ['sam@x.org', 'pat@x.org']) {
      const listing = await listObjects(`notifications/${email}/`, env);
      expect(listing.objects).toHaveLength(1);
      expect(await getObject<any>(listing.objects[0].key, env)).toMatchObject({ type: 'submission_waiting', submissionId: 's1', userId: email });
    }
    expect(Object.keys(await getAskLog(env, 's1')).sort()).toEqual(['pat@x.org', 'sam@x.org']);
  });

  it('words a reminder differently and goes to COMMS_EMAIL_OVERRIDE on dev', async () => {
    env.COMMS_EMAIL_OVERRIDE = 'test@dev.org';
    await askForApproval(submission, ['sam@x.org'], actor, 'reminder', env);
    const input = (sendSpy.mock.calls[0][0] as SendEmailCommand).input;
    expect(input.Destination?.ToAddresses).toEqual(['test@dev.org']);
    expect(input.Content?.Simple?.Subject?.Data).toBe('[for sam@x.org] Reminder: your approval is needed for "Gate shifts"');
    expect(input.Content?.Simple?.Body?.Text?.Data).toContain('Lee Cadre asked for your approval of "Gate shifts".');
  });

  it('reads the older log of one time per person as both first and last', async () => {
    await env.STORE.put('approval_asks/old', JSON.stringify({ 'sam@x.org': '2026-10-01T00:00:00.000Z' }));
    expect(await getAskLog(env, 'old')).toEqual({ 'sam@x.org': { first: '2026-10-01T00:00:00.000Z', last: '2026-10-01T00:00:00.000Z' } });
    clearMemoryCache();
    await recordAsked(env, 'old', ['sam@x.org', 'pat@x.org'], '2026-10-05T00:00:00.000Z');
    expect(await getAskLog(env, 'old')).toEqual({
      'sam@x.org': { first: '2026-10-01T00:00:00.000Z', last: '2026-10-05T00:00:00.000Z' },
      'pat@x.org': { first: '2026-10-05T00:00:00.000Z', last: '2026-10-05T00:00:00.000Z' },
    });
  });

  it('still notifies in the app and records who got it when the email fails, then throws', async () => {
    sendSpy.mockRejectedValueOnce(new Error('throttled'));
    await expect(askForApproval(submission, ['sam@x.org', 'nobody@x.org'], actor, 'added', env)).rejects.toThrow(/throttled/);

    // Sam has an account, so the bell has the ask and the log records it
    const listing = await listObjects('notifications/sam@x.org/', env);
    expect(listing.objects).toHaveLength(1);
    expect(await getObject<any>(listing.objects[0].key, env)).toMatchObject({ type: 'submission_waiting', submissionId: 's1' });
    // nobody@x.org has no account: neither email nor bell reached them, so they weren't asked
    expect((await listObjects('notifications/nobody@x.org/', env)).objects).toHaveLength(0);
    expect(Object.keys(await getAskLog(env, 's1'))).toEqual(['sam@x.org']);
  });

  it('records everyone it emailed, with or without an account', async () => {
    await askForApproval(submission, ['sam@x.org', 'nobody@x.org'], actor, 'added', env);
    expect(Object.keys(await getAskLog(env, 's1')).sort()).toEqual(['nobody@x.org', 'sam@x.org']);
  });
});

describe('notifyRequestSubmitted', () => {
  beforeEach(async () => {
    await putUser(user('kim@x.org'));
    await putUser(user('cadre@x.org', { commsCadre: true }));
  });

  const bell = async (email: string) => {
    const listing = await listObjects(`notifications/${email}/`, env);
    return Promise.all(listing.objects.map((o: { key: string }) => getObject<any>(o.key, env)));
  };

  it('asks the listed approvers and tells the Comms Cadre in the app, and records the asks, when email fails', async () => {
    sendSpy.mockRejectedValue(new Error('SES rejected the credentials'));
    const live = { ...submission, id: 's2', requiredApprovers: ['pat@x.org', 'Kim@x.org'] };
    await expect(notifyRequestSubmitted(live, { id: 'id-sam', email: 'sam@x.org', name: 'sam' }, env)).resolves.toBeUndefined();

    // Both emails were tried (approvers, then the Comms Cadre) and both failed
    expect(sendSpy).toHaveBeenCalledTimes(2);
    for (const email of ['pat@x.org', 'kim@x.org']) {
      expect(await bell(email)).toEqual([expect.objectContaining({ type: 'submission_waiting', submissionId: 's2' })]);
    }
    expect(await bell('cadre@x.org')).toEqual([expect.objectContaining({ type: 'request_submitted', submissionId: 's2' })]);
    expect(await bell('sam@x.org')).toEqual([]);
    expect(Object.keys(await getAskLog(env, 's2')).sort()).toEqual(['cadre@x.org', 'kim@x.org', 'pat@x.org']);
  });

  it('emails, notifies and records everyone when email works', async () => {
    const live = { ...submission, id: 's3', requiredApprovers: ['pat@x.org'] };
    await notifyRequestSubmitted(live, { id: 'id-sam', email: 'sam@x.org', name: 'sam' }, env);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(await bell('pat@x.org')).toHaveLength(1);
    expect(await bell('cadre@x.org')).toHaveLength(1);
    expect(Object.keys(await getAskLog(env, 's3')).sort()).toEqual(['cadre@x.org', 'pat@x.org']);
  });
});

describe('notification settings', () => {
  it('default to on, drop the old group setting, and are read by email or id', async () => {
    expect(await getUserNotificationSettings('sam@x.org', env)).toEqual({ notifyOnReplies: true, submitterUpdates: true });
    expect(await wantsSubmitterUpdates(env, 'sam@x.org')).toBe(true);
    expect(await wantsSubmitterUpdates(env, 'nobody@x.org')).toBe(true);

    await putUser(user('old@x.org', { notificationSettings: { notifyOnReplies: false, notifyOnGroupContent: false } }));
    expect(await getUserNotificationSettings('old@x.org', env)).toEqual({ notifyOnReplies: false, submitterUpdates: true });

    await updateUserNotificationSettings('sam@x.org', { notifyOnReplies: true, submitterUpdates: false }, env);
    expect(await wantsSubmitterUpdates(env, 'sam@x.org')).toBe(false);
    expect(await wantsSubmitterUpdates(env, 'id-sam')).toBe(false);
    const saved = await getObject<any>('user/sam@x.org', env);
    expect(saved.notificationSettings).toEqual({ notifyOnReplies: true, submitterUpdates: false });
  });
});
