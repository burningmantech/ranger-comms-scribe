import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { router } from '../../src/handlers/commsCalendar';
import { router as contentRouter } from '../../src/handlers/contentSubmission';
import { router as appRouter } from '../../src/index';
import * as calendarService from '../../src/services/commsCalendarService';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { saveUser } from '../../src/services/userService';
import { CreateSession } from '../../src/utils/sessionManager';
import { CommsCalendarEntry, CouncilRole, User, UserType } from '../../src/types';
import { createMockObjectStore } from '../helpers/mockObjectStore';

/**
 * Comms Calendar API. Users come from the dev auth bypass (DEV_BYPASS_AUTH): the session name
 * picks the admin, user2 (Comms Cadre), council (Council, read only) or member. SES is mocked.
 */

const SESSIONS = {
  admin: 'dev-admin-session',
  cadre: 'dev-user2-session',
  council: 'dev-council-session',
  member: 'dev-member-session',
};

async function call(
  env: any,
  method: string,
  path: string,
  { session = SESSIONS.admin, body }: { session?: string; body?: unknown } = {},
  via: { fetch: (request: Request, env: any) => Promise<Response> } = router,
): Promise<Response> {
  return via.fetch(new Request(`http://localhost/api/comms-calendar${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env);
}

const sample = {
  subject: 'Thank you Rangers', targetDate: '2025-09-15', dateSent: '2025-09-17', method: 'Announce',
  team: 'Council', contactEmails: ['council@example.org'], comments: '',
};

describe('Comms Calendar API', () => {
  let env: any;
  let sendSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    clearMemoryCache();
    env = { STORE: createMockObjectStore(), DEV_BYPASS_AUTH: 'true', FRONTEND_URL: 'https://scrivenly.com' };
    sendSpy = jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockImplementation(async () => ({ MessageId: 'test-message-id', $metadata: {} }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const lastEmail = () => (sendSpy.mock.calls[sendSpy.mock.calls.length - 1][0] as SendEmailCommand).input;

  describe('access', () => {
    it('lets Admin and Comms Cadre change entries', async () => {
      for (const session of [SESSIONS.admin, SESSIONS.cadre]) {
        const created = await call(env, 'POST', '/', { session, body: sample });
        expect(created.status).toBe(201);
        const entry = (await created.json()) as CommsCalendarEntry;
        expect((await call(env, 'PUT', `/${entry.id}`, { session, body: { comments: 'HB' } })).status).toBe(200);
        expect((await call(env, 'DELETE', `/${entry.id}`, { session })).status).toBe(200);
      }
      const list: any = await (await call(env, 'GET', '/', { session: SESSIONS.cadre })).json();
      expect(list.canEdit).toBe(true);
    });

    it('lets Council look but not change anything', async () => {
      const entry = (await (await call(env, 'POST', '/', { body: sample })).json()) as CommsCalendarEntry;
      const session = SESSIONS.council;

      const list = await call(env, 'GET', '/', { session });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ canEdit: false, entries: [{ id: entry.id }] });
      expect((await call(env, 'GET', '/upcoming?today=2026-09-01', { session })).status).toBe(200);

      expect((await call(env, 'POST', '/', { session, body: sample })).status).toBe(403);
      expect((await call(env, 'PUT', `/${entry.id}`, { session, body: { comments: 'x' } })).status).toBe(403);
      expect((await call(env, 'DELETE', `/${entry.id}`, { session })).status).toBe(403);
      expect((await call(env, 'POST', `/${entry.id}/nudge`, { session, body: {} })).status).toBe(403);
      expect((await call(env, 'POST', '/import', { session, body: { entries: [sample] } })).status).toBe(403);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('lets the Communications Manager edit', async () => {
      const manager: User = {
        id: 'cm-id', email: 'cm@example.org', name: 'Comms Manager', userType: UserType.CouncilManager,
        approved: true, isAdmin: false, groups: [], roles: ['CouncilManager'],
      };
      await saveUser(manager, env);
      await putObject(`council_members:role:${CouncilRole.CommunicationsManager}`, [{
        id: 'm1', userId: 'cm-id', role: CouncilRole.CommunicationsManager, email: 'cm@example.org', name: 'Comms Manager',
        active: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      }], env);
      const session = await CreateSession(manager.email, { email: manager.email, name: manager.name }, env);

      const list: any = await (await call(env, 'GET', '/', { session })).json();
      expect(list.canEdit).toBe(true);
      expect((await call(env, 'POST', '/', { session, body: sample })).status).toBe(201);
    });

    it('turns away members', async () => {
      expect((await call(env, 'GET', '/', { session: SESSIONS.member })).status).toBe(403);
      expect((await call(env, 'GET', '/upcoming', { session: SESSIONS.member })).status).toBe(403);
    });
  });

  it('validates and updates entries', async () => {
    expect((await call(env, 'POST', '/', { body: { ...sample, link: 'javascript:alert(1)' } })).status).toBe(400);
    const entry = (await (await call(env, 'POST', '/', { body: { ...sample, link: 'https://example.org/m' } })).json()) as CommsCalendarEntry;
    expect(entry).toMatchObject({ subject: 'Thank you Rangers', source: 'manual', createdBy: 'dev@localhost', nudges: [] });

    const response = await call(env, 'PUT', `/${entry.id}`, {
      body: { link: null, notRepeating: true, nudges: [{ fake: true }], createdBy: 'someone' },
    });
    const updated = (await response.json()) as CommsCalendarEntry;
    expect(updated.link).toBeUndefined();
    expect(updated.notRepeating).toBe(true);
    expect(updated.nudges).toEqual([]);
    expect(updated.createdBy).toBe('dev@localhost');
    expect((await call(env, 'PUT', '/missing', { body: { comments: 'x' } })).status).toBe(404);
  });

  it('lists upcoming anniversaries that no later entry continues', async () => {
    const last = (await (await call(env, 'POST', '/', { body: sample })).json()) as CommsCalendarEntry;
    await call(env, 'POST', '/', { body: { ...sample, subject: 'Far away', targetDate: '2026-01-13' } });

    let upcoming: any = await (await call(env, 'GET', '/upcoming?today=2026-09-01&days=42')).json();
    expect(upcoming.items).toHaveLength(1);
    expect(upcoming.items[0]).toMatchObject({ anniversary: '2026-09-15', daysUntil: 14, entry: { id: last.id } });

    await call(env, 'POST', '/', { body: { ...sample, targetDate: '2026-09-15', dateSent: null, carriedFromId: last.id } });
    upcoming = await (await call(env, 'GET', '/upcoming?today=2026-09-01&days=42')).json();
    expect(upcoming.items).toHaveLength(0);
  });

  describe('import', () => {
    it('creates rows and skips them the second time', async () => {
      const rows = [
        sample,
        { ...sample, subject: 'Did you find some radion equipment?', team: 'Logistics' },
        { ...sample, subject: 'thank you rangers', targetDate: '2026-02-01' }, // same subject and cycle
        { subject: '' },
      ];
      const first: any = await (await call(env, 'POST', '/import', { body: { entries: rows } })).json();
      expect(first.created).toBe(2);
      expect(first.skipped).toEqual([
        { index: 2, reason: 'Already in the calendar' },
        { index: 3, reason: 'Subject is required' },
      ]);
      expect(first.entries[0].source).toBe('import');

      const second: any = await (await call(env, 'POST', '/import', { body: { entries: rows } })).json();
      expect(second.created).toBe(0);
      const list: any = await (await call(env, 'GET', '/')).json();
      expect(list.entries).toHaveLength(2);
    });

    it('needs a list of rows', async () => {
      expect((await call(env, 'POST', '/import', { body: { rows: [] } })).status).toBe(400);
    });
  });

  describe('nudge', () => {
    it('emails the team, replies to the sender and logs the nudge', async () => {
      const entry = (await (await call(env, 'POST', '/', { body: sample })).json()) as CommsCalendarEntry;
      const response = await call(env, 'POST', `/${entry.id}/nudge`, { body: { note: 'Same again?' } });
      expect(response.status).toBe(200);

      const input = lastEmail();
      expect(input.Destination?.ToAddresses).toEqual(['council@example.org']);
      expect(input.ReplyToAddresses).toBeUndefined(); // dev@localhost isn't a deliverable address
      expect(input.Content?.Simple?.Subject?.Data).toBe('Planning ahead: "Thank you Rangers" for this year?');
      expect(input.Content?.Simple?.Body?.Text?.Data).toContain('https://scrivenly.com/comms-request');

      const body: any = await response.json();
      expect(body.entry.nudges).toHaveLength(1);
      expect(body.entry.nudges[0]).toMatchObject({ by: 'dev@localhost', byName: 'Dev Admin', to: ['council@example.org'], note: 'Same again?' });
    });

    it('sends Reply-To as the nudger when that is a real address', async () => {
      const entry = (await (await call(env, 'POST', '/', { body: sample })).json()) as CommsCalendarEntry;
      const user: User = {
        id: 'hb', email: 'hb@example.org', name: 'Hazel', userType: UserType.CommsCadre,
        approved: true, isAdmin: false, groups: [], roles: ['CommsCadre'],
      };
      await saveUser(user, env);
      const session = await CreateSession(user.email, { email: user.email, name: user.name }, env);
      expect((await call(env, 'POST', `/${entry.id}/nudge`, { session, body: { to: ['a@example.org', 'B@example.org'] } })).status).toBe(200);
      const input = lastEmail();
      expect(input.ReplyToAddresses).toEqual(['hb@example.org']);
      expect(input.Destination?.ToAddresses).toEqual(['a@example.org', 'b@example.org']);
    });

    it('logs nothing when the email fails', async () => {
      const entry = (await (await call(env, 'POST', '/', { body: sample })).json()) as CommsCalendarEntry;
      sendSpy.mockImplementation(async () => { throw new Error('throttled'); });
      expect((await call(env, 'POST', `/${entry.id}/nudge`, { body: {} })).status).toBe(502);
      clearMemoryCache();
      const stored = await getObject<CommsCalendarEntry>(`comms_calendar/${entry.id}`, env);
      expect(stored?.nudges).toEqual([]);
    });

    it('sends only to NUDGE_EMAIL_OVERRIDE when set, but logs the team', async () => {
      env.NUDGE_EMAIL_OVERRIDE = 'alex@example.org';
      const entry = (await (await call(env, 'POST', '/', { body: sample })).json()) as CommsCalendarEntry;
      const body: any = await (await call(env, 'POST', `/${entry.id}/nudge`, { body: {} })).json();
      expect(lastEmail().Destination?.ToAddresses).toEqual(['alex@example.org']);
      expect(body.entry.nudges[0].to).toEqual(['council@example.org']);
    });

    it('needs someone to send to', async () => {
      const entry = (await (await call(env, 'POST', '/', { body: { ...sample, contactEmails: [] } })).json()) as CommsCalendarEntry;
      expect((await call(env, 'POST', `/${entry.id}/nudge`, { body: {} })).status).toBe(400);
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe('from sent requests', () => {
    const submitter: User = {
      id: 'submitter-uuid', email: 'vc@example.org', name: 'Volunteer Coordinator', userType: UserType.Member,
      approved: true, isAdmin: false, groups: [], roles: [],
    };

    function submission(overrides: Record<string, unknown> = {}) {
      return {
        id: 'sub-1', title: 'Please update your Burner Profile!', content: '', submittedBy: 'submitter-uuid',
        submittedAt: '2026-09-20T10:00:00Z', status: 'approved',
        formFields: [
          { id: 'owner', label: 'Owner', value: 'Volunteer Coordinators', type: 'text', required: true },
          { id: 'publishBy', label: 'Publish By', value: '2026-10-01', type: 'date', required: true },
          { id: 'audience', label: 'Audience', value: calendarService.SINGULAR_AUDIENCE_LABEL, type: 'text', required: true },
          { id: 'replyToAddress', label: 'Reply-To Address', value: 'vc-team@example.org', type: 'text', required: true },
        ],
        comments: [], approvals: [], changes: [], commsCadreApprovals: 0, councilManagerApprovals: [],
        announcementSent: false, assignedCouncilManagers: [], requiredApprovers: [],
        ...overrides,
      };
    }

    const send = (id = 'sub-1') => contentRouter.fetch(new Request(`http://localhost/api/content/submissions/${id}/send-email`, {
      method: 'POST', headers: { Authorization: `Bearer ${SESSIONS.admin}` },
    }), env);

    beforeEach(async () => {
      env.ANNOUNCE_EMAIL_TO = 'announce@example.org';
      env.PUBLIC_URL = 'https://scrivenly.com/api';
      await saveUser(submitter, env);
    });

    it('records a sent announcement, once', async () => {
      await putObject('content_submissions/sub-1', submission(), env);
      expect((await send()).status).toBe(200);

      const stored = await getObject<CommsCalendarEntry>('comms_calendar/sub-sub-1', env);
      expect(stored).toMatchObject({
        subject: 'Please update your Burner Profile!', submissionId: 'sub-1', source: 'submission',
        targetDate: '2026-10-01', method: 'Announce', team: 'Volunteer Coordinators',
        contactEmails: ['vc@example.org', 'vc-team@example.org'],
      });
      expect(stored?.dateSent).toBe(calendarService.pacificDate(new Date().toISOString()));

      // Comms edits the team; a resend (dev) updates the same entry and keeps the edit
      await call(env, 'PUT', '/sub-sub-1', { body: { team: 'VCs' } });
      env.ALLOW_ANNOUNCEMENT_RESEND = true;
      expect((await send()).status).toBe(200);
      const list: any = await (await call(env, 'GET', '/')).json();
      expect(list.entries).toHaveLength(1);
      expect(list.entries[0].team).toBe('VCs');
    });

    it('updates an entry already linked by hand instead of adding one', async () => {
      await putObject('content_submissions/sub-1', submission(), env);
      const linked = (await (await call(env, 'POST', '/', { body: { ...sample, submissionId: 'sub-1' } })).json()) as CommsCalendarEntry;
      await send();
      const list: any = await (await call(env, 'GET', '/')).json();
      expect(list.entries).toHaveLength(1);
      expect(list.entries[0]).toMatchObject({ id: linked.id, subject: 'Please update your Burner Profile!', team: 'Council' });
    });

    it('still reports the send when the calendar write fails', async () => {
      await putObject('content_submissions/sub-1', submission(), env);
      jest.spyOn(calendarService, 'syncCalendarFromSubmission').mockRejectedValue(new Error('store down'));
      expect((await send()).status).toBe(200);
    });

    it('records a request marked sent by hand', async () => {
      await putObject('content_submissions/sub-1', submission({
        formFields: [{ id: 'audience', label: 'Audience', value: calendarService.NEWSLETTER_AUDIENCE_LABEL, type: 'text', required: true }],
      }), env);
      const response = await contentRouter.fetch(new Request('http://localhost/api/content/submissions/sub-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SESSIONS.admin}` },
        body: JSON.stringify({ status: 'sent', sentAt: '2026-10-04T18:00:00Z' }),
      }), env);
      expect(response.status).toBe(200);
      const stored = await getObject<CommsCalendarEntry>('comms_calendar/sub-sub-1', env);
      expect(stored).toMatchObject({ method: 'Newsletter', dateSent: '2026-10-04', contactEmails: ['vc@example.org'] });
    });

    it('adds a request from the calendar page', async () => {
      await putObject('content_submissions/sub-1', submission(), env);
      const response = await call(env, 'POST', '/from-submission/sub-1');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 'sub-sub-1', method: 'Announce', targetDate: '2026-10-01' });
      expect((await call(env, 'POST', '/from-submission/nope')).status).toBe(404);
      expect((await call(env, 'POST', '/from-submission/sub-1', { session: SESSIONS.council })).status).toBe(403);
    });
  });

  it('is reachable through the app router', async () => {
    const response = await call(env, 'GET', '', {}, appRouter as any);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ entries: [], canEdit: true });
  });
});
