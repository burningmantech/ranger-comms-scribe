import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { router as newsletterRouter } from '../../src/handlers/newsletter';
import { router as publicRouter } from '../../src/handlers/publicNews';
import { router as contentRouter } from '../../src/handlers/contentSubmission';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { createMockObjectStore } from '../helpers/mockObjectStore';
import { saveUser, getUser } from '../../src/services/userService';
import { withDerivedAccess } from '../../src/services/access';
import { CreateSession } from '../../src/utils/sessionManager';

/**
 * Newsletter editions end to end on the in-memory store, through the routers, signed in as
 * stored people (seedPeople). SES is mocked.
 */

const PUBLIC_URL = 'https://dev.scrivenly.com/api';
const ANNOUNCE_TO = 'announce-test@example.org';
// Session IDs of stored people (seedPeople): an Admin who is the Communications Manager, a
// Comms Cadre reviewer and a member
let ADMIN = '';
let CADRE = '';
let MEMBER = '';

async function seedPeople(env: any) {
  const people = [
    { id: 'dev-admin', email: 'dev@localhost', name: 'Dev Admin', isAdmin: true, councilRole: 'CommunicationsManager' },
    { id: 'dev-user2', email: 'user2@localhost', name: 'Test Reviewer', commsCadre: true },
    { id: 'dev-member', email: 'member@localhost', name: 'Test Member' },
  ];
  for (const p of people) {
    await saveUser(withDerivedAccess({
      verified: true, groups: [], roles: [], userType: 'Member', isAdmin: false,
      commsCadre: false, councilRole: null, ...p,
    } as any) as any, env);
  }
  ADMIN = await CreateSession('dev@localhost', { email: 'dev@localhost' }, env);
  CADRE = await CreateSession('user2@localhost', { email: 'user2@localhost' }, env);
  MEMBER = await CreateSession('member@localhost', { email: 'member@localhost' }, env);
}

const lexical = (text: string) => JSON.stringify({
  root: {
    type: 'root', version: 1, direction: null, format: '', indent: 0,
    children: [{
      type: 'paragraph', version: 1, direction: null, format: '', indent: 0,
      children: [{ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text }],
    }],
  },
});

function submission(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Request ${id}`,
    content: lexical(`The full document of ${id}.`),
    submittedBy: 'dev-member',
    submittedAt: `2026-06-0${id.length}T10:00:00Z`,
    status: 'approved',
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

async function call(router: any, env: any, method: string, path: string, session: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers.Authorization = `Bearer ${session}`;
  const response: Response = await router.fetch(new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env);
  const text = await response.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed };
}

const nl = (env: any, method: string, path: string, session: string | null = CADRE, body?: unknown) =>
  call(newsletterRouter, env, method, `/api/newsletter${path}`, session, body);

describe('newsletter editions', () => {
  let env: any;
  let sendSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMemoryCache();
    env = {
      STORE: createMockObjectStore(),
      PUBLIC_URL,
      FRONTEND_URL: 'https://dev.scrivenly.com',
      ANNOUNCE_EMAIL_TO: ANNOUNCE_TO,
    };
    sendSpy = jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockImplementation(async () => ({ MessageId: 'test-message-id', $metadata: {} }) as any);

    await seedPeople(env);

    // A newsletter item with a blurb, photos, links, a dated deadline and its own document
    await putObject('content_submissions/ticket', submission('ticket', {
      title: 'Claim your Ranger Tickets & Stuff by July 12th!',
      audiences: ['newsletter', 'singular'],
      newsletter: {
        headline: 'Important: Claim your tickets by July 12th!',
        blurb: lexical('The Clubhouse Ticketing is now open!'),
        photos: [{ src: '/api/gallery/aurora.jpg', alt: 'Aurora', credit: 'Vader' }],
        links: [{ label: 'Clubhouse', url: 'https://clubhouse.example' }],
        readMore: { kind: 'document' },
      },
      keyDates: [{ date: '2099-07-12', label: 'Claim your Ranger tickets and stuff', link: 'https://clubhouse.example', linkLabel: 'Clubhouse' }],
    }), env);
    // An older request: newsletter only by its audience label, no newsletter item
    await putObject('content_submissions/legacy', submission('legacy', {
      title: 'Join the Operators!',
      formFields: [{ id: 'audience', label: 'Audience', value: 'Include in Ranger Newsletter (sent over Ranger Announce)', type: 'text', required: true }],
    }), env);
    // Still in review: shown as upcoming
    await putObject('content_submissions/review', submission('review', { status: 'in_review', audiences: ['newsletter'] }), env);
    // Not for the newsletter
    await putObject('content_submissions/allcom', submission('allcom', { audiences: ['allcom'] }), env);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is only for the Comms Cadre and Admins', async () => {
    expect((await nl(env, 'GET', '/editions', MEMBER)).status).toBe(403);
    expect((await nl(env, 'POST', '/editions', MEMBER, {})).status).toBe(403);
    expect((await nl(env, 'GET', '/tray', MEMBER)).status).toBe(403);
    expect((await nl(env, 'GET', '/editions', CADRE)).status).toBe(200);
    expect((await nl(env, 'GET', '/editions', ADMIN)).status).toBe(200);
  });

  it('numbers editions from #11 and refuses a number that is taken', async () => {
    const first = await nl(env, 'POST', '/editions', CADRE, { subject: 'Tickets & Stuff' });
    expect(first.status).toBe(201);
    expect(first.body.edition.number).toBe(11);
    expect(first.body.edition.status).toBe('draft');
    const second = await nl(env, 'POST', '/editions', CADRE, {});
    expect(second.body.edition.number).toBe(12);
    expect((await nl(env, 'POST', '/editions', CADRE, { number: 11 })).status).toBe(409);
    const renumber = await nl(env, 'PUT', `/editions/${second.body.edition.id}`, CADRE, { version: 1, number: 11 });
    expect(renumber.status).toBe(409);
  });

  it('runs an edition from the tray to Announce and the public pages', async () => {
    // The tray: approved newsletter items ready, the one in review upcoming
    const tray = await nl(env, 'GET', '/tray');
    expect(tray.status).toBe(200);
    expect(tray.body.ready.map((i: any) => i.id).sort()).toEqual(['legacy', 'ticket']);
    expect(tray.body.upcoming.map((i: any) => i.id)).toEqual(['review']);

    const created = await nl(env, 'POST', '/editions', CADRE, { subject: 'Tickets & Stuff, Travel, and Opportunities!' });
    const id = created.body.edition.id;

    // Add both from the tray; they leave the tray
    let res = await nl(env, 'POST', `/editions/${id}/sections/from-submission`, CADRE, { submissionId: 'ticket' });
    expect(res.status).toBe(200);
    res = await nl(env, 'POST', `/editions/${id}/sections/from-submission`, CADRE, { submissionId: 'legacy' });
    expect(res.status).toBe(200);
    let edition = res.body.edition;
    expect(edition.version).toBe(3);
    expect(edition.sections.map((s: any) => s.heading)).toEqual(['Important: Claim your tickets by July 12th!', 'Join the Operators!']);
    // The legacy item starts from its full document
    expect(edition.sections[1].body).toContain('The full document of legacy.');
    expect(edition.sections[0].readMore).toEqual({ kind: 'document', submissionId: 'ticket' });
    expect((await getObject<any>('content_submissions/ticket', env)).newsletterEditionId).toBe(id);
    expect((await nl(env, 'GET', '/tray')).body.ready).toEqual([]);
    // Not twice, and not one still in review
    expect((await nl(env, 'POST', `/editions/${id}/sections/from-submission`, CADRE, { submissionId: 'ticket' })).status).toBe(409);
    expect((await nl(env, 'POST', `/editions/${id}/sections/from-submission`, CADRE, { submissionId: 'review' })).status).toBe(409);

    // The calendar comes from the item's key dates
    expect(res.body.calendar.map((r: any) => r.label)).toEqual(['Claim your Ranger tickets and stuff']);

    // A stale save is refused; a current one adds a custom section and a manual calendar row
    expect((await nl(env, 'PUT', `/editions/${id}`, CADRE, { version: 1, subject: 'x' })).status).toBe(409);
    res = await nl(env, 'PUT', `/editions/${id}`, CADRE, {
      version: edition.version,
      sections: [
        ...edition.sections,
        { id: 'custom-1', heading: '4th of Juplaya', body: lexical('The Aurora Borealis gave us a show at Juplaya!'),
          photos: [{ src: '/api/gallery/aurora.jpg', alt: 'Aurora', credit: 'Vader' }], links: [], readMore: { kind: 'none' }, keyDates: [],
          // A client can't make a section claim a request
          sourceSubmissionId: 'allcom' },
      ],
      calendar: [{ id: 'bm', date: '2099-08-30', endDate: '2099-09-07', label: 'Burning Man!' }],
    });
    expect(res.status).toBe(200);
    edition = res.body.edition;
    expect(edition.sections[2].kind).toBe('custom');
    expect(edition.sections[2].sourceSubmissionId).toBeUndefined();
    expect(edition.sections[0].sourceSubmissionId).toBe('ticket');

    // Bad input is a 400 with a message
    const bad = await nl(env, 'PUT', `/editions/${id}`, CADRE, { version: edition.version, calendar: [{ id: 'x', date: 'July 12', label: 'x' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/YYYY-MM-DD/);

    // Preview: the subject, the linked document's address, the calendar
    const preview = await nl(env, 'GET', `/editions/${id}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.subject).toBe('Tickets & Stuff, Travel, and Opportunities! - Ranger News #11');
    const slug = (await getObject<any>('content_submissions/ticket', env)).publicSlug;
    expect(slug).toMatch(/^claim-your-ranger-tickets-stuff-by-july-12th-[0-9a-f]{6}$/);
    expect(preview.body.html).toContain(`https://dev.scrivenly.com/news/${slug}`);
    expect(preview.body.html).toContain('Burning Man!');
    // The document page isn't public until the edition goes out
    expect((await call(publicRouter, env, 'GET', `/api/public/news/${slug}`, null)).status).toBe(404);

    // Sending needs approval first
    expect((await nl(env, 'POST', `/editions/${id}/send`, ADMIN)).status).toBe(409);

    // Approval: the Comms Cadre alone isn't enough; with the Communications Manager it is
    res = await nl(env, 'POST', `/editions/${id}/submit`, CADRE);
    expect(res.body.edition.status).toBe('in_review');
    res = await nl(env, 'POST', `/editions/${id}/approve`, CADRE, { status: 'approved', version: edition.version });
    expect(res.body.edition.status).toBe('in_review');
    expect(res.body.approval.commsCadre.met).toBe(true);
    expect(res.body.approval.commsManager.met).toBe(false);
    expect((await nl(env, 'POST', `/editions/${id}/approve`, MEMBER, { status: 'approved' })).status).toBe(403);
    res = await nl(env, 'POST', `/editions/${id}/approve`, ADMIN, { status: 'approved', version: edition.version });
    expect(res.body.edition.status).toBe('approved');
    expect(res.body.edition.approvedVersion).toBe(edition.version);

    // An edit after approval needs approving again
    res = await nl(env, 'PUT', `/editions/${id}`, CADRE, { version: edition.version, tagline: 'All the Dust that Fits Under Your Hat!' });
    edition = res.body.edition;
    expect(edition.status).toBe('in_review');
    expect(res.body.approval.commsCadre.met).toBe(false);
    expect((await nl(env, 'POST', `/editions/${id}/send`, ADMIN)).status).toBe(409);
    await nl(env, 'POST', `/editions/${id}/approve`, CADRE, { status: 'approved', version: edition.version });
    res = await nl(env, 'POST', `/editions/${id}/approve`, ADMIN, { status: 'approved', version: edition.version });
    expect(res.body.edition.status).toBe('approved');

    // A test send goes to the sender only
    res = await nl(env, 'POST', `/editions/${id}/send-test`, CADRE);
    expect(res.status).toBe(200);
    let input = (sendSpy.mock.calls[0][0] as SendEmailCommand).input;
    expect(input.Destination?.ToAddresses).toEqual(['user2@localhost']);
    expect(input.Content?.Simple?.Subject?.Data).toBe('[TEST] Tickets & Stuff, Travel, and Opportunities! - Ranger News #11');

    // Send to Announce
    res = await nl(env, 'POST', `/editions/${id}/send`, CADRE);
    expect(res.status).toBe(200);
    expect(res.body.edition.status).toBe('sent');
    input = (sendSpy.mock.calls[1][0] as SendEmailCommand).input;
    expect(input.Destination?.ToAddresses).toEqual([ANNOUNCE_TO]);
    expect(input.Content?.Simple?.Subject?.Data).toBe('Tickets & Stuff, Travel, and Opportunities! - Ranger News #11');
    const html = input.Content?.Simple?.Body?.Html?.Data || '';
    expect(html).toContain('All the Dust that Fits Under Your Hat! • #11');
    expect(html).toContain(`https://dev.scrivenly.com/news/${slug}`);

    // The submitter hears about the request this edition finished (not the one that also goes out on its own)
    const toMember = sendSpy.mock.calls.map((c) => (c[0] as SendEmailCommand).input).filter((i) => i.Destination?.ToAddresses?.includes('member@localhost'));
    expect(toMember).toHaveLength(1);
    expect(toMember[0].Content?.Simple?.Subject?.Data).toBe('"Join the Operators!" was sent');
    expect(toMember[0].Content?.Simple?.Body?.Text?.Data).toContain('went out in Ranger News #11');

    // Sent: frozen, and the requests know where they went
    expect((await nl(env, 'PUT', `/editions/${id}`, CADRE, { version: res.body.edition.version, subject: 'x' })).status).toBe(409);
    expect((await nl(env, 'POST', `/editions/${id}/send`, CADRE)).status).toBe(409);
    const ticket = await getObject<any>('content_submissions/ticket', env);
    expect(ticket.newsletterSentIn).toBe(11);
    expect(ticket.status).toBe('approved'); // it also goes out on its own (singular)
    expect(ticket.publicPublishedAt).toBeTruthy();
    const legacy = await getObject<any>('content_submissions/legacy', env);
    expect(legacy.newsletterSentIn).toBe(11);
    expect(legacy.status).toBe('sent'); // newsletter only: done
    // Both requests are in the Comms Calendar with the edition; the custom section isn't
    const ticketEntry = await getObject<any>('comms_calendar/sub-ticket', env);
    expect(ticketEntry).toMatchObject({
      subject: 'Claim your Ranger Tickets & Stuff by July 12th!', method: 'Both', newsletterSentIn: 11, submissionId: 'ticket',
    });
    expect(ticketEntry.dateSent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await getObject<any>('comms_calendar/sub-legacy', env)).toMatchObject({ method: 'Newsletter', newsletterSentIn: 11 });
    // Its own announcement later updates the same entry and keeps the first date it went out
    expect((await call(contentRouter, env, 'POST', '/api/content/submissions/ticket/send-email', ADMIN)).status).toBe(200);
    clearMemoryCache();
    expect(await getObject<any>('comms_calendar/sub-ticket', env)).toMatchObject({
      method: 'Both', newsletterSentIn: 11, dateSent: ticketEntry.dateSent,
    });
    expect((await env.STORE.list('comms_calendar/')).objects).toHaveLength(2);

    // The next edition is #12 and the sent items aren't in the tray
    expect((await nl(env, 'GET', '/editions')).body.nextNumber).toBe(12);
    expect((await nl(env, 'GET', '/tray')).body.ready).toEqual([]);

    // Public pages: the archive, the edition, the document
    const archive = await call(publicRouter, env, 'GET', '/api/public/newsletter', null);
    expect(archive.body.editions).toEqual([expect.objectContaining({ number: 11, subject: 'Tickets & Stuff, Travel, and Opportunities! - Ranger News #11' })]);
    const page = await call(publicRouter, env, 'GET', '/api/public/newsletter/11', null);
    expect(page.status).toBe(200);
    expect(page.body.html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(page.body.html).toContain('Mark your calendar!');
    expect(page.body.html).not.toContain('View this edition in your browser');
    expect(html).toContain('View this edition in your browser');
    expect((await call(publicRouter, env, 'GET', '/api/public/newsletter/12', null)).status).toBe(404);
    const doc = await call(publicRouter, env, 'GET', `/api/public/news/${slug}`, null);
    expect(doc.status).toBe(200);
    expect(doc.body.html).toContain('The full document of ticket.');
    expect(doc.body.html).toContain('>Claim your Ranger Tickets &amp; Stuff by July 12th!</h1>');
    expect((await call(publicRouter, env, 'GET', '/api/public/news/not-a-slug', null)).status).toBe(404);
  });

  it('releases a request when its section is removed or the edition deleted', async () => {
    const id = (await nl(env, 'POST', '/editions', CADRE, {})).body.edition.id;
    let res = await nl(env, 'POST', `/editions/${id}/sections/from-submission`, CADRE, { submissionId: 'ticket' });
    res = await nl(env, 'PUT', `/editions/${id}`, CADRE, { version: res.body.edition.version, sections: [] });
    expect(res.status).toBe(200);
    expect((await getObject<any>('content_submissions/ticket', env)).newsletterEditionId).toBeUndefined();
    expect((await nl(env, 'GET', '/tray')).body.ready.map((i: any) => i.id)).toContain('ticket');

    await nl(env, 'POST', `/editions/${id}/sections/from-submission`, CADRE, { submissionId: 'legacy' });
    expect((await nl(env, 'DELETE', `/editions/${id}`, CADRE)).status).toBe(200);
    expect((await getObject<any>('content_submissions/legacy', env)).newsletterEditionId).toBeUndefined();
  });

  it('shows when a request changed since its section was made, and refreshes it', async () => {
    const id = (await nl(env, 'POST', '/editions', CADRE, {})).body.edition.id;
    let res = await nl(env, 'POST', `/editions/${id}/sections/from-submission`, CADRE, { submissionId: 'ticket' });
    const sectionId = res.body.edition.sections[0].id;
    expect(res.body.sources[sectionId]).toEqual(expect.objectContaining({ submissionId: 'ticket', changed: false }));

    // The cadre edits the request's blurb from the review page
    const patch = await call(contentRouter, env, 'PATCH', '/api/content/submissions/ticket/newsletter', CADRE, {
      newsletter: { headline: 'Claim by July 12!', blurb: lexical('New blurb'), photos: [], links: [], readMore: { kind: 'none' } },
    });
    expect(patch.status).toBe(200);
    res = await nl(env, 'GET', `/editions/${id}`);
    expect(res.body.sources[sectionId].changed).toBe(true);
    res = await nl(env, 'POST', `/editions/${id}/sections/${sectionId}/refresh`, CADRE);
    expect(res.body.edition.sections[0].heading).toBe('Claim by July 12!');
    expect(res.body.edition.sections[0].id).toBe(sectionId);
    expect(res.body.sources[sectionId].changed).toBe(false);
  });

  it('keeps the version and the approval when a save changes nothing', async () => {
    const created = (await nl(env, 'POST', '/editions', CADRE, { subject: 'Same' })).body.edition;
    await nl(env, 'POST', `/editions/${created.id}/override-approve`, ADMIN, { reason: 'ok' });
    const res = await nl(env, 'PUT', `/editions/${created.id}`, CADRE, { version: created.version, subject: 'Same', sections: [], calendar: created.calendar, calendarHidden: [] });
    expect(res.status).toBe(200);
    expect(res.body.edition.version).toBe(created.version);
    expect(res.body.edition.status).toBe('approved');
  });

  it('counts an approval for the Communications Manager once the approver is given that role', async () => {
    const id = (await nl(env, 'POST', '/editions', CADRE, { subject: 'S' })).body.edition.id;
    let res = await nl(env, 'POST', `/editions/${id}/approve`, CADRE, { status: 'approved' });
    expect(res.body.edition.status).toBe('in_review');
    expect(res.body.approval.commsManager.met).toBe(false);
    expect(res.body.commsManagers).toEqual([{ name: 'Dev Admin', email: 'dev@localhost' }]);
    expect(res.body.permissions.approvesAs).toEqual({ commsCadre: true, commsManager: false });

    // An Admin makes the cadre member the Communications Manager too (People page)
    const reviewer = await getUser('user2@localhost', env);
    await saveUser({ ...reviewer!, councilRole: 'CommunicationsManager' } as any, env);
    res = await nl(env, 'GET', `/editions/${id}`, CADRE);
    expect(res.body.approval.commsManager).toEqual({ met: true, by: 'Test Reviewer' });
    expect(res.body.edition.status).toBe('approved');
    expect((await getObject<any>(`newsletter_editions/${id}`, env)).status).toBe('approved');
  });

  it('lets an Admin or the Communications Manager override, with a reason', async () => {
    const id = (await nl(env, 'POST', '/editions', CADRE, { subject: 'S' })).body.edition.id;
    expect((await nl(env, 'POST', `/editions/${id}/override-approve`, CADRE, { reason: 'urgent' })).status).toBe(403);
    expect((await nl(env, 'POST', `/editions/${id}/override-approve`, ADMIN, {})).status).toBe(400);
    const res = await nl(env, 'POST', `/editions/${id}/override-approve`, ADMIN, { reason: 'Council asked for it today' });
    expect(res.body.edition.status).toBe('approved');
    expect(res.body.approval.override).toBe(true);
    expect(res.body.edition.comments[0].content).toBe('Approval override: Council asked for it today');
  });

  it('keeps an approval from blocking when changes are requested', async () => {
    const id = (await nl(env, 'POST', '/editions', CADRE, { subject: 'S' })).body.edition.id;
    await nl(env, 'POST', `/editions/${id}/approve`, CADRE, { status: 'rejected', comment: 'Fix the date' });
    const res = await nl(env, 'POST', `/editions/${id}/approve`, ADMIN, { status: 'approved' });
    expect(res.body.edition.status).toBe('in_review');
    expect(res.body.approval.rejectedBy).toEqual(['Test Reviewer']);
    expect(res.body.edition.comments.map((c: any) => c.content)).toEqual(['Changes requested: Fix the date']);
  });

  /** An edition with the ticket and legacy sections, approved by the Comms Cadre and the Communications Manager. */
  async function approvedEdition(): Promise<string> {
    const id = (await nl(env, 'POST', '/editions', CADRE, { subject: 'Tickets' })).body.edition.id;
    await nl(env, 'POST', `/editions/${id}/sections/from-submission`, CADRE, { submissionId: 'ticket' });
    const res = await nl(env, 'POST', `/editions/${id}/sections/from-submission`, CADRE, { submissionId: 'legacy' });
    const version = res.body.edition.version;
    await nl(env, 'POST', `/editions/${id}/approve`, CADRE, { status: 'approved', version });
    const approved = await nl(env, 'POST', `/editions/${id}/approve`, ADMIN, { status: 'approved', version });
    expect(approved.body.edition.status).toBe('approved');
    return id;
  }

  const announceSends = () => sendSpy.mock.calls
    .map((c) => (c[0] as SendEmailCommand).input)
    .filter((i) => i.Destination?.ToAddresses?.includes(ANNOUNCE_TO));

  it('lets the Communications Manager review but not edit, and says so', async () => {
    await saveUser(withDerivedAccess({
      id: 'cm-only', email: 'cm@localhost', name: 'Casey Manager', verified: true, groups: [], roles: [], userType: 'Member',
      isAdmin: false, commsCadre: false, councilRole: 'CommunicationsManager',
    } as any) as any, env);
    const MANAGER = await CreateSession('cm@localhost', { email: 'cm@localhost' }, env);
    const id = (await nl(env, 'POST', '/editions', CADRE, { subject: 'S' })).body.edition.id;

    const seen = await nl(env, 'GET', `/editions/${id}`, MANAGER);
    expect(seen.status).toBe(200);
    expect(seen.body.permissions.canEdit).toBe(false);
    expect(seen.body.permissions.canApprove).toBe(true);
    expect((await nl(env, 'GET', `/editions/${id}`, CADRE)).body.permissions.canEdit).toBe(true);
    expect((await nl(env, 'GET', `/editions/${id}`, ADMIN)).body.permissions.canEdit).toBe(true);

    const save = await nl(env, 'PUT', `/editions/${id}`, MANAGER, { version: 1, subject: 'Mine' });
    expect(save.status).toBe(403);
    expect(save.body.error).toBe('Only the Comms Cadre can work on the newsletter');
    expect((await nl(env, 'POST', `/editions/${id}/approve`, MANAGER, { status: 'approved', version: 1 })).status).toBe(200);
  });

  it('records who saved last by name, for the conflict message', async () => {
    const created = (await nl(env, 'POST', '/editions', ADMIN, { subject: 'S' })).body.edition;
    expect(created.updatedByName).toBe('Dev Admin');
    const saved = await nl(env, 'PUT', `/editions/${created.id}`, CADRE, { version: created.version, subject: 'Theirs' });
    expect(saved.body.edition.updatedBy).toBe('dev-user2');
    expect(saved.body.edition.updatedByName).toBe('Test Reviewer');
    const stale = await nl(env, 'PUT', `/editions/${created.id}`, ADMIN, { version: created.version, subject: 'Mine' });
    expect(stale.status).toBe(409);
    expect(stale.body.edition.updatedByName).toBe('Test Reviewer');
    // Adding from the tray is a save too
    const added = await nl(env, 'POST', `/editions/${created.id}/sections/from-submission`, ADMIN, { submissionId: 'ticket' });
    expect(added.body.edition.updatedByName).toBe('Dev Admin');
  });

  it('reports a failed send as a 502 without the SES text, and the edition can be sent again', async () => {
    const id = await approvedEdition();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    sendSpy.mockImplementationOnce(async () => { throw new Error('MessageRejected: Email address is not verified. secret-arn'); });
    const failed = await nl(env, 'POST', `/editions/${id}/send`, CADRE);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("The email couldn't be sent, so nothing went out. Try again later.");
    expect(JSON.stringify(failed.body)).not.toMatch(/MessageRejected|secret-arn/);
    expect((await getObject<any>(`newsletter_editions/${id}`, env)).status).toBe('approved');
    expect(await getObject<any>('newsletter_sent/11', env)).toBeNull();
    expect((await getObject<any>('content_submissions/legacy', env)).newsletterSentIn).toBeUndefined();

    const retry = await nl(env, 'POST', `/editions/${id}/send`, CADRE);
    expect(retry.status).toBe(200);
    expect(retry.body.edition.status).toBe('sent');
  });

  it('reports a failed test send as a 502 without the SES text', async () => {
    const id = (await nl(env, 'POST', '/editions', CADRE, { subject: 'S' })).body.edition.id;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    sendSpy.mockImplementationOnce(async () => { throw new Error('Throttling: Maximum sending rate exceeded'); });
    const failed = await nl(env, 'POST', `/editions/${id}/send-test`, CADRE);
    expect(failed.status).toBe(502);
    expect(failed.body.error).not.toMatch(/Throttling/);
  });

  it('marks the edition sent as soon as the email has gone, whatever fails afterwards', async () => {
    const id = await approvedEdition();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const put = env.STORE.put.bind(env.STORE);
    env.STORE.put = async (key: string, ...rest: any[]) => {
      // Every write after the email has gone (Read more pages are published before it)
      const afterEmail = announceSends().length > 0;
      if (key.startsWith('newsletter_sent/') || (afterEmail && (key.startsWith('content_submissions/') || key.startsWith('comms_calendar/')))) {
        throw new Error(`store down for ${key}`);
      }
      return put(key, ...rest);
    };

    const sent = await nl(env, 'POST', `/editions/${id}/send`, CADRE);
    expect(sent.status).toBe(200);
    expect(sent.body.edition.status).toBe('sent');
    clearMemoryCache();
    expect((await getObject<any>(`newsletter_editions/${id}`, env)).status).toBe('sent');

    // Never twice
    expect((await nl(env, 'POST', `/editions/${id}/send`, CADRE)).status).toBe(409);
    expect(announceSends()).toHaveLength(1);
  });

  it('sends to COMMS_EMAIL_OVERRIDE on dev, naming Announce in the subject, as announcements do', async () => {
    env.COMMS_EMAIL_OVERRIDE = 'override@example.org';
    const id = await approvedEdition();
    const res = await nl(env, 'POST', `/editions/${id}/send`, CADRE);
    expect(res.status).toBe(200);
    expect(announceSends()).toHaveLength(0);
    const toOverride = sendSpy.mock.calls.map((c) => (c[0] as SendEmailCommand).input)
      .filter((i) => i.Destination?.ToAddresses?.includes('override@example.org'));
    const edition = toOverride.find((i) => /Ranger News #11/.test(i.Content?.Simple?.Subject?.Data || ''));
    expect(edition?.Destination?.ToAddresses).toEqual(['override@example.org']);
    expect(edition?.Content?.Simple?.Subject?.Data).toBe(`[for ${ANNOUNCE_TO}] Tickets - Ranger News #11`);
    // The public page keeps the real subject
    expect((await getObject<any>('newsletter_sent/11', env)).subject).toBe('Tickets - Ranger News #11');
  });

  it('refuses to send without ANNOUNCE_EMAIL_TO', async () => {
    delete env.ANNOUNCE_EMAIL_TO;
    const id = (await nl(env, 'POST', '/editions', CADRE, { subject: 'S' })).body.edition.id;
    expect((await nl(env, 'POST', `/editions/${id}/send`, ADMIN)).status).toBe(503);
  });
});

describe('request newsletter fields', () => {
  let env: any;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    clearMemoryCache();
    env = { STORE: createMockObjectStore(), PUBLIC_URL, ANNOUNCE_EMAIL_TO: ANNOUNCE_TO };
    jest.spyOn(SESv2Client.prototype, 'send').mockImplementation(async () => ({ MessageId: 'm', $metadata: {} }) as any);
    return seedPeople(env);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const content = (method: string, path: string, session: string, body?: unknown) =>
    call(contentRouter, env, method, `/api/content${path}`, session, body);

  it('keeps the newsletter item, key dates, audiences and writing help from the form', async () => {
    const res = await content('POST', '/submissions', MEMBER, {
      title: 'Field Support Needs You', content: lexical('Long doc'), status: 'in_review',
      audiences: ['newsletter'],
      writingHelp: { blurb: true, document: false },
      newsletter: { headline: 'Field Support', photos: [], links: [{ label: 'Sign up', url: 'https://example.org' }], readMore: { kind: 'document' } },
      keyDates: [{ date: '2026-08-15', label: 'Perimeter training' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.audiences).toEqual(['newsletter']);
    expect(res.body.writingHelp).toEqual({ blurb: true });
    expect(res.body.newsletter).toEqual({ headline: 'Field Support', photos: [], links: [{ label: 'Sign up', url: 'https://example.org' }], readMore: { kind: 'document' } });
    expect(res.body.keyDates).toEqual([{ date: '2026-08-15', label: 'Perimeter training' }]);
  });

  it('drops the newsletter item when the newsletter is not an audience, and rejects bad input', async () => {
    const res = await content('POST', '/submissions', MEMBER, {
      title: 'x', content: '', audiences: ['allcom'],
      newsletter: { photos: [], links: [], readMore: { kind: 'none' } },
    });
    expect(res.body.newsletter).toBeUndefined();
    const bad = await content('POST', '/submissions', MEMBER, {
      title: 'x', content: '', audiences: ['newsletter'],
      newsletter: { photos: [], links: [{ label: 'x', url: 'javascript:alert(1)' }], readMore: { kind: 'none' } },
    });
    expect(bad.status).toBe(400);
    const tooMany = await content('POST', '/submissions', MEMBER, {
      title: 'x', content: '', audiences: ['newsletter'],
      newsletter: { photos: [1, 2, 3].map(() => ({ src: '/api/gallery/a.jpg', alt: '' })), links: [], readMore: { kind: 'none' } },
    });
    expect(tooMany.status).toBe(400);
  });

  it('PATCH edits the newsletter item; PUT leaves it alone', async () => {
    await putObject('content_submissions/s1', submission('s1', { submittedBy: 'someone', audiences: ['newsletter'], newsletterEditionId: 'ed-9' }), env);
    // A member who isn't the submitter or an approver can't
    expect((await content('PATCH', '/submissions/s1/newsletter', MEMBER, { keyDates: [] })).status).toBe(403);
    const res = await content('PATCH', '/submissions/s1/newsletter', CADRE, {
      newsletter: { blurb: lexical('Written by Comms'), photos: [], links: [], readMore: { kind: 'none' } },
      keyDates: [{ date: '2026-08-01', label: 'Stories due' }],
    });
    expect(res.status).toBe(200);
    // A whole stale copy through PUT doesn't undo it or move the item
    await content('PUT', '/submissions/s1', ADMIN, { title: 'New title', newsletter: null, keyDates: [], newsletterEditionId: null, publicSlug: 'evil' });
    const stored = await getObject<any>('content_submissions/s1', env);
    expect(stored.title).toBe('New title');
    expect(stored.newsletter.blurb).toContain('Written by Comms');
    expect(stored.keyDates).toEqual([{ date: '2026-08-01', label: 'Stories due' }]);
    expect(stored.newsletterEditionId).toBe('ed-9');
    expect(stored.publicSlug).toBeUndefined();

    await putObject('content_submissions/s1', { ...stored, newsletterSentIn: 11 }, env);
    expect((await content('PATCH', '/submissions/s1/newsletter', CADRE, { keyDates: [] })).status).toBe(409);
  });

  it('send-email refuses a newsletter-only request, and a request sent on its own gets no public page', async () => {
    await putObject('content_submissions/n1', submission('n1', { audiences: ['newsletter'] }), env);
    const refused = await content('POST', '/submissions/n1/send-email', ADMIN);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/newsletter/);

    await putObject('content_submissions/s2', submission('s2', { audiences: ['newsletter', 'singular'] }), env);
    expect((await content('POST', '/submissions/s2/send-email', ADMIN)).status).toBe(200);
    const sent = await getObject<any>('content_submissions/s2', env);
    expect(sent.status).toBe('sent');
    // Only an edition that links to it publishes its page
    expect(sent.publicSlug).toBeUndefined();
    expect(sent.publicPublishedAt).toBeUndefined();
  });
});
