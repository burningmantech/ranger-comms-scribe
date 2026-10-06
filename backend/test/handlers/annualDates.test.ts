import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { router } from '../../src/handlers/annualDates';
import { router as contentRouter } from '../../src/handlers/contentSubmission';
import { router as calendarRouter } from '../../src/handlers/commsCalendar';
import { clearMemoryCache, getObject } from '../../src/services/cacheService';
import { cleanCalendar, cleanKeyDate, cleanKeyDates } from '../../src/utils/newsletterInput';
import { ContentSubmission } from '../../src/types';
import { createMockObjectStore } from '../helpers/mockObjectStore';

/**
 * Annual dates API and a request's linked dates. Users come from the dev auth bypass: admin,
 * user2 (Comms Cadre), member.
 */

const SESSIONS = { admin: 'dev-admin-session', cadre: 'dev-user2-session', member: 'dev-member-session' };

async function call(
  env: any,
  method: string,
  path: string,
  { session = SESSIONS.admin, body }: { session?: string; body?: unknown } = {},
  via: { fetch: (request: Request, env: any) => Promise<Response> } = router,
): Promise<Response> {
  return via.fetch(new Request(`http://localhost/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env);
}

const social = {
  name: 'Ranger Social',
  rule: { kind: 'laborDay', offsetDays: -6 },
  startTime: '18:00',
  endTime: '22:00',
  createdFrom: { submissionId: 'abc', text: '6pm - 10pm on Sept. 1 2026' },
};

describe('Annual dates API', () => {
  let env: any;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    clearMemoryCache();
    env = { STORE: createMockObjectStore(), DEV_BYPASS_AUTH: 'true', FRONTEND_URL: 'https://scrivenly.com' };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lets anyone signed in add and list; editors change and delete, the creator only changes', async () => {
    const created = await call(env, 'POST', '/annual-dates', { session: SESSIONS.member, body: social });
    expect(created.status).toBe(201);
    const entry = await created.json() as any;
    expect(entry).toMatchObject({ name: 'Ranger Social', rule: { kind: 'laborDay', offsetDays: -6 }, createdBy: 'member@localhost' });

    const other = await (await call(env, 'POST', '/annual-dates', { session: SESSIONS.admin, body: { name: 'Gate opens', rule: { kind: 'laborDay', offsetDays: -8 } } })).json() as any;

    const list = await (await call(env, 'GET', '/annual-dates', { session: SESSIONS.member })).json() as any;
    expect(list.entries.map((e: any) => e.name)).toEqual(['Gate opens', 'Ranger Social']);
    expect(list.canEditAll).toBe(false);

    expect((await call(env, 'PUT', `/annual-dates/${entry.id}`, { session: SESSIONS.member, body: { endTime: '23:00' } })).status).toBe(200);
    expect((await call(env, 'PUT', `/annual-dates/${other.id}`, { session: SESSIONS.member, body: { name: 'x' } })).status).toBe(403);
    expect((await call(env, 'DELETE', `/annual-dates/${other.id}`, { session: SESSIONS.member })).status).toBe(403);
    expect((await call(env, 'DELETE', `/annual-dates/${entry.id}`, { session: SESSIONS.member })).status).toBe(403);

    const moved = await call(env, 'PUT', `/annual-dates/${other.id}`, {
      session: SESSIONS.cadre, body: { overrides: { 2027: { date: '2027-08-27' } } },
    });
    expect(moved.status).toBe(200);
    expect((await moved.json() as any).overrides).toEqual({ 2027: { date: '2027-08-27' } });
    expect((await call(env, 'DELETE', `/annual-dates/${other.id}`, { session: SESSIONS.cadre })).status).toBe(200);
  });

  it('rejects bad rules and times', async () => {
    const bad = async (body: unknown) => (await call(env, 'POST', '/annual-dates', { body })).status;
    expect(await bad({ name: 'x', rule: { kind: 'fixed', month: 2, day: 30 } })).toBe(400);
    expect(await bad({ name: 'x', rule: { kind: 'laborDay', offsetDays: 1.5 } })).toBe(400);
    expect(await bad({ name: 'x', rule: { kind: 'weekly' } })).toBe(400);
    expect(await bad({ name: '', rule: { kind: 'fixed', month: 1, day: 1 } })).toBe(400);
    expect(await bad({ name: 'x', rule: { kind: 'fixed', month: 1, day: 1 }, startTime: '6pm' })).toBe(400);
    expect(await bad({ name: 'x', rule: { kind: 'fixed', month: 2, day: 29 } })).toBe(201);
  });

  it('keeps a key date linked to an annual date (requests, edition sections and calendar rows)', () => {
    const row = { date: '2026-09-01', label: 'Ranger Social', annualDateId: 'a1' };
    expect(cleanKeyDate(row)).toEqual(row);
    expect(cleanKeyDates([row])).toEqual([row]);
    expect(cleanCalendar([{ id: 'c1', ...row }])).toEqual([{ id: 'c1', ...row }]);
  });

  it('saves a request\'s linked dates on create and through /date-links, and PUT leaves them alone', async () => {
    const link = { id: 'l1', annualDateId: 'a1', field: 'body', text: 'Sept. 1 2026', year: 2026 };
    const res = await call(env, 'POST', '/content/submissions', {
      session: SESSIONS.member,
      body: { title: 'Social', content: 'Join us 6pm - 10pm on Sept. 1 2026', status: 'submitted', dateLinks: [link] },
    }, contentRouter);
    expect(res.status).toBeLessThan(300);
    const created = await res.json() as any;
    const id = (created.submission || created).id;
    const stored = () => getObject<ContentSubmission>(`content_submissions/${id}`, env);
    expect((await stored())?.dateLinks).toEqual([link]);

    const put = await call(env, 'PUT', `/content/submissions/${id}`, { session: SESSIONS.member, body: { dateLinks: [] } }, contentRouter);
    expect(put.status).toBeLessThan(300);
    expect((await stored())?.dateLinks).toEqual([link]);

    const status = (await stored())?.status;
    const moved = { ...link, text: 'Aug. 31 2027', year: 2027 };
    const saved = await call(env, 'PUT', `/content/submissions/${id}/date-links`, { session: SESSIONS.member, body: { dateLinks: [moved] } }, contentRouter);
    expect(saved.status).toBe(200);
    expect((await stored())?.dateLinks).toEqual([moved]);
    expect((await stored())?.status).toBe(status);

    expect((await call(env, 'PUT', `/content/submissions/${id}/date-links`, {
      session: SESSIONS.member, body: { dateLinks: [{ ...link, field: 'title' }] },
    }, contentRouter)).status).toBe(400);
    expect((await call(env, 'PUT', `/content/submissions/${id}/date-links`, {
      session: 'dev-council-session', body: { dateLinks: [] },
    }, contentRouter)).status).toBe(403);
    // The Comms Cadre (and other Comms Calendar editors) link dates from the calendar too
    expect((await call(env, 'PUT', `/content/submissions/${id}/date-links`, {
      session: SESSIONS.cadre, body: { dateLinks: [moved] },
    }, contentRouter)).status).toBe(200);
  });
});

describe('Comms Calendar entries: document text and linked dates', () => {
  let env: any;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMemoryCache();
    env = { STORE: createMockObjectStore(), DEV_BYPASS_AUTH: 'true', FRONTEND_URL: 'https://scrivenly.com' };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const calendar = (method: string, path: string, session: string, body?: unknown) =>
    calendarRouter.fetch(new Request(`http://localhost/api/comms-calendar${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), env);

  it('keeps the document text and its linked dates; clears them with null', async () => {
    const created = await (await calendar('POST', '/', SESSIONS.cadre, {
      subject: 'Ranger Social', targetDate: '2026-08-20', documentText: 'Join us\r\n6pm - 10pm on Sept. 1 2026.',
    })).json() as any;
    expect(created.documentText).toBe('Join us\n6pm - 10pm on Sept. 1 2026.');

    const link = { id: 'l1', annualDateId: 'a1', field: 'body', text: '6pm - 10pm on Sept. 1 2026', year: 2026 };
    const linked = await calendar('PUT', `/${created.id}`, SESSIONS.cadre, { dateLinks: [link] });
    expect(linked.status).toBe(200);
    expect((await linked.json() as any).dateLinks).toEqual([link]);

    expect((await calendar('PUT', `/${created.id}`, SESSIONS.cadre, { dateLinks: [{ ...link, field: 'blurb' }] })).status).toBe(400);
    expect((await calendar('PUT', `/${created.id}`, SESSIONS.member, { dateLinks: [] })).status).toBe(403);

    const cleared = await (await calendar('PUT', `/${created.id}`, SESSIONS.cadre, { documentText: null, dateLinks: [] })).json() as any;
    expect(cleared.documentText).toBeUndefined();
    expect(cleared.dateLinks).toBeUndefined();
  });
});

describe('Comms Calendar: past messages and planned entries', () => {
  let env: any;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMemoryCache();
    env = { STORE: createMockObjectStore(), DEV_BYPASS_AUTH: 'true', FRONTEND_URL: 'https://scrivenly.com' };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const calendar = (method: string, path: string, session: string, body?: unknown) =>
    calendarRouter.fetch(new Request(`http://localhost/api/comms-calendar${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), env);

  const message = {
    title: 'Reminder about Ranger Social',
    content: 'Tuesday Ranger Social, on September 1, at 5 pm',
    richTextContent: JSON.stringify({ root: { type: 'root', children: [] } }),
    link: 'https://docs.google.com/document/d/abc/edit',
    publishedOn: '2026-08-12',
  };

  it("files last year's message as a sent request on last year's entry, which this year's continues", async () => {
    const thisYear = await (await calendar('POST', '/', SESSIONS.cadre, {
      subject: 'Reminder about Ranger Social', targetDate: '2027-08-12', team: 'VCs', documentText: 'plain text',
    })).json() as any;
    const res = await calendar('POST', `/${thisYear.id}/message`, SESSIONS.cadre, message);
    expect(res.status).toBe(200);
    const { entry, holder, submissionId } = await res.json() as any;
    expect(holder).toMatchObject({ subject: 'Reminder about Ranger Social', targetDate: '2026-08-12', dateSent: '2026-08-12', submissionId, link: message.link, team: 'VCs' });
    expect(entry.carriedFromId).toBe(holder.id);
    expect(entry.documentText).toBeUndefined();
    const submission = await getObject<ContentSubmission>(`content_submissions/${submissionId}`, env);
    expect(submission).toMatchObject({ status: 'sent', title: message.title, importedFrom: message.link, sentAt: '2026-08-12T12:00:00.000Z' });

    // Again: same request, same last year's entry
    const again = await (await calendar('POST', `/${thisYear.id}/message`, SESSIONS.cadre, { ...message, title: 'Edited' })).json() as any;
    expect(again.holder.id).toBe(holder.id);
    expect(again.submissionId).toBe(submissionId);
    expect((await getObject<ContentSubmission>(`content_submissions/${submissionId}`, env))?.title).toBe('Edited');

    expect((await calendar('POST', `/${thisYear.id}/message`, SESSIONS.member, message)).status).toBe(403);
  });

  it("files a message that went out in this entry's cycle on the entry itself", async () => {
    const entry = await (await calendar('POST', '/', SESSIONS.cadre, { subject: 'Survey', targetDate: '2026-09-14' })).json() as any;
    const { holder } = await (await calendar('POST', `/${entry.id}/message`, SESSIONS.cadre, { ...message, publishedOn: '2026-09-14' })).json() as any;
    expect(holder.id).toBe(entry.id);
  });

  it('lists planned entries due soon and not yet sent in Coming up', async () => {
    await calendar('POST', '/', SESSIONS.cadre, { subject: 'Camp Hosts feedback', targetDate: '2026-10-26' });
    await calendar('POST', '/', SESSIONS.cadre, { subject: 'Already sent', targetDate: '2026-10-20', dateSent: '2026-10-05' });
    await calendar('POST', '/', SESSIONS.cadre, { subject: 'Much later', targetDate: '2027-03-04' });
    const { items } = await (await calendar('GET', '/upcoming?days=42&today=2026-10-06', SESSIONS.cadre)).json() as any;
    expect(items.map((i: any) => [i.entry.subject, i.kind, i.anniversary])).toEqual([['Camp Hosts feedback', 'planned', '2026-10-26']]);
  });
});
