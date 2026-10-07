import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { router as rootRouter } from '../../src/index';
import { clearMemoryCache } from '../../src/services/cacheService';
import { saveUser, getUser } from '../../src/services/userService';
import { withDerivedAccess } from '../../src/services/access';
import { resetFeedbackRateLimit } from '../../src/services/feedbackService';
import { CreateSession } from '../../src/utils/sessionManager';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

/**
 * The feedback tab: who sees it (global switch, per-person override), sending feedback (stored,
 * emailed to Admins with the screenshot and diagnostics), and Admin → Feedback. SES is mocked.
 */

let env: any;
let sendSpy: jest.SpyInstance;
const sessions: Record<string, string> = {};

// The smallest thing that passes for a JPEG (magic bytes FF D8 FF)
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')}`;

async function person(key: string, email: string, extra: Record<string, unknown> = {}) {
  await saveUser(withDerivedAccess({
    id: `id-${key}`, email, name: key, verified: true, groups: [], roles: [],
    userType: 'Member', isAdmin: false, commsCadre: false, councilRole: null, ...extra,
  } as any) as any, env);
  sessions[key] = await CreateSession(email, { email }, env);
}

async function call(method: string, path: string, who: string, body?: unknown) {
  const res: Response = await rootRouter.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessions[who]}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env);
  const type = res.headers.get('Content-Type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.arrayBuffer(), type };
}

const enabledFor = async (who: string) => (await call('GET', '/api/feedback/config', who)).body.enabled;
const sent = (i = 0) => (sendSpy.mock.calls[i][0] as SendEmailCommand).input;

const diagnostics = {
  environment: { userAgent: 'Jest', viewport: { width: 1280, height: 800, devicePixelRatio: 2 } },
  app: { build: 'main.abc123.js' },
  network: [
    { method: 'GET', url: '/api/content/submissions', status: 200, durationMs: 40 },
    { method: 'PUT', url: '/api/content/submissions/s1', status: 500, durationMs: 90 },
  ],
  errors: [{ message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n    at save (main.js:1:2)' }],
  console: [],
  breadcrumbs: [],
};

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  clearMemoryCache();
  resetFeedbackRateLimit();
  env = { STORE: new MemoryObjectStore(), FRONTEND_URL: 'https://scribe.example.org' };
  sendSpy = jest.spyOn(SESv2Client.prototype, 'send').mockImplementation(async () => ({ MessageId: 'm', $metadata: {} }) as any);
  await person('admin', 'admin@x.org', { isAdmin: true });
  await person('admin2', 'admin2@x.org', { isAdmin: true });
  await person('member', 'member@x.org');
  await person('tester', 'tester@x.org');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('who sees the feedback tab', () => {
  it('follows the global switch unless the person has their own setting', async () => {
    expect(await enabledFor('member')).toBe(false); // off until an Admin turns it on

    // On for one tester while it's off for everyone
    let res = await call('PUT', '/api/admin/people/tester%40x.org/feedback', 'admin', { enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.person.feedbackEnabled).toBe(true);
    expect(await enabledFor('tester')).toBe(true);
    expect(await enabledFor('member')).toBe(false);

    // On for everyone, off for one person
    res = await call('PUT', '/api/admin/feedback/settings', 'admin', { enabled: true });
    expect(res.body.settings).toMatchObject({ enabled: true, updatedBy: 'admin@x.org' });
    await call('PUT', '/api/admin/people/member%40x.org/feedback', 'admin', { enabled: false });
    expect(await enabledFor('member')).toBe(false);
    expect(await enabledFor('admin2')).toBe(true);

    // Back to following the global switch
    await call('PUT', '/api/admin/people/member%40x.org/feedback', 'admin', { enabled: null });
    expect(await enabledFor('member')).toBe(true);
    expect((await getUser('member@x.org', env))!.feedbackEnabled).toBeNull();

    // The People list shows each person's setting
    res = await call('GET', '/api/admin/people', 'admin');
    const byEmail = Object.fromEntries(res.body.people.map((p: any) => [p.email, p.feedbackEnabled]));
    expect(byEmail).toMatchObject({ 'tester@x.org': true, 'member@x.org': null });
  });

  it('only Admins change the switches', async () => {
    expect((await call('PUT', '/api/admin/feedback/settings', 'member', { enabled: true })).status).toBe(403);
    expect((await call('PUT', '/api/admin/people/member%40x.org/feedback', 'member', { enabled: true })).status).toBe(403);
    expect((await call('GET', '/api/admin/feedback', 'member')).status).toBe(403);
    expect((await call('PUT', '/api/admin/people/member%40x.org/feedback', 'admin', { enabled: 'yes' })).status).toBe(400);
    expect((await call('PUT', '/api/admin/people/nobody%40x.org/feedback', 'admin', { enabled: true })).status).toBe(404);
  });
});

describe('sending feedback', () => {
  it('is refused while the tab is off for the person', async () => {
    const res = await call('POST', '/api/feedback', 'member', { message: 'Hi', url: '/requests' });
    expect(res.status).toBe(403);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('stores it and emails every Admin the screenshot and diagnostics', async () => {
    await call('PUT', '/api/admin/feedback/settings', 'admin', { enabled: true });
    const res = await call('POST', '/api/feedback', 'member', {
      message: 'Saving <b>broke</b>\nwhen I clicked Save',
      url: 'https://scribe.example.org/tracked-changes/s1',
      screenshot: JPEG,
      diagnostics,
    });
    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(true);

    const email = sent();
    expect(email.Destination!.ToAddresses!.sort()).toEqual(['admin2@x.org', 'admin@x.org']);
    expect(email.ReplyToAddresses).toEqual(['member@x.org']);
    expect(email.Content!.Simple!.Subject!.Data).toBe('[Scribe feedback] member: Saving <b>broke</b>');
    const html = email.Content!.Simple!.Body!.Html!.Data!;
    expect(html).toContain('Saving &lt;b&gt;broke&lt;/b&gt;'); // escaped
    expect(html).toContain('PUT /api/content/submissions/s1</code> → 500');
    expect(html).toContain('TypeError: x is undefined');
    expect(html).toContain('cid:screenshot');
    expect(html).toContain(`/admin?tab=feedback&amp;id=${res.body.id}`);
    const attachments = email.Content!.Simple!.Attachments!;
    expect(attachments.map((a) => [a.FileName, a.ContentDisposition])).toEqual([
      ['screenshot.jpg', 'INLINE'],
      [`feedback-${res.body.id}.json`, 'ATTACHMENT'],
    ]);
    const attached = JSON.parse(Buffer.from(attachments[1].RawContent!).toString());
    expect(attached.diagnostics.network).toHaveLength(2);

    // Admin → Feedback lists it, opens it and shows the screenshot
    let list = await call('GET', '/api/admin/feedback', 'admin');
    expect(list.body.feedback).toHaveLength(1);
    expect(list.body.feedback[0]).toMatchObject({ id: res.body.id, hasScreenshot: true, counts: { network: 2, failed: 1, errors: 1 } });
    expect(list.body.feedback[0].diagnostics).toBeUndefined();
    const one = await call('GET', `/api/admin/feedback/${res.body.id}`, 'admin');
    expect(one.body.feedback).toMatchObject({ message: 'Saving <b>broke</b>\nwhen I clicked Save', emailedTo: expect.arrayContaining(['admin@x.org']) });
    const shot = await call('GET', `/api/admin/feedback/${res.body.id}/screenshot`, 'admin');
    expect(shot.type).toBe('image/jpeg');
    expect(new Uint8Array(shot.body as ArrayBuffer)[0]).toBe(0xff);

    // Handled, with notes; then deleted
    const updated = await call('PUT', `/api/admin/feedback/${res.body.id}`, 'admin', { handled: true, notes: 'Fixed in 1.2' });
    expect(updated.body.feedback).toMatchObject({ handled: true, handledBy: 'admin@x.org', notes: 'Fixed in 1.2' });
    expect((await call('DELETE', `/api/admin/feedback/${res.body.id}`, 'admin')).status).toBe(200);
    list = await call('GET', '/api/admin/feedback', 'admin');
    expect(list.body.feedback).toHaveLength(0);
    expect((await call('GET', `/api/admin/feedback/${res.body.id}/screenshot`, 'admin')).status).toBe(404);
  });

  it('keeps the feedback when the email fails, and sends without a screenshot', async () => {
    await call('PUT', '/api/admin/people/tester%40x.org/feedback', 'admin', { enabled: true });
    sendSpy.mockRejectedValueOnce(new Error('SES down'));
    const res = await call('POST', '/api/feedback', 'tester', { message: 'No screenshot', url: '/requests' });
    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(false);
    const one = await call('GET', `/api/admin/feedback/${res.body.id}`, 'admin');
    expect(one.body.feedback).toMatchObject({ hasScreenshot: false, emailedTo: [] });
    expect(one.body.feedback.emailError).toContain('SES down');
  });

  it('checks the message and the screenshot', async () => {
    await call('PUT', '/api/admin/feedback/settings', 'admin', { enabled: true });
    expect((await call('POST', '/api/feedback', 'member', { message: '  ' })).status).toBe(400);
    expect((await call('POST', '/api/feedback', 'member', { message: 'x'.repeat(5001) })).status).toBe(400);
    expect((await call('POST', '/api/feedback', 'member', { message: 'Hi', screenshot: 'data:image/png;base64,iVBORw0KGgo=' })).status).toBe(400);
    expect((await call('POST', '/api/feedback', 'member', { message: 'Hi', screenshot: `data:image/jpeg;base64,${Buffer.from('not a jpeg').toString('base64')}` })).status).toBe(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('limits how much one person sends in an hour', async () => {
    await call('PUT', '/api/admin/feedback/settings', 'admin', { enabled: true });
    for (let i = 0; i < 20; i++) {
      expect((await call('POST', '/api/feedback', 'member', { message: `Report ${i}` })).status).toBe(201);
    }
    expect((await call('POST', '/api/feedback', 'member', { message: 'One more' })).status).toBe(429);
  });
});
