import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { router } from '../../src/handlers/contentSubmission';
import { updateChangeStatusHandler, batchUpdateStatusHandler, createTrackedChangeHandler, getTrackedChangesHandler } from '../../src/handlers/trackedChanges';
import { CustomRequest } from '../../src/types';
import { clearMemoryCache, getObject, putObject } from '../../src/services/cacheService';
import { approvedFieldValue, validReplyTo, embedGalleryImages } from '../../src/services/announcementEmail';
import { createMockObjectStore } from '../helpers/mockObjectStore';

/**
 * The announcement email (POST /send-email) and its preview (GET /email-preview) are built by
 * the same code: the approved document rendered for email, the approved Subject, Reply-To and
 * signature, sent to ANNOUNCE_EMAIL_TO. SES is mocked: nothing is sent.
 */

const FIXTURE = fs.readFileSync(path.join(__dirname, '../fixtures/announcementDocument.json'), 'utf8');
const PUBLIC_URL = 'https://dev.scrivenly.com/api';
const ANNOUNCE_TO = 'announce-test@example.org';

const lexical = (text: string) => JSON.stringify({
  root: {
    type: 'root', version: 1, direction: null, format: '', indent: 0,
    children: [{
      type: 'paragraph', version: 1, direction: null, format: '', indent: 0,
      children: [{ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text }],
    }],
  },
});

const admin = { id: 'dev-admin', email: 'dev@localhost', name: 'Dev Admin', userType: 'Admin' };

async function call(env: any, method: string, urlPath: string, session = 'dev-admin-session'): Promise<Response> {
  return router.fetch(new Request(`http://localhost/api/content${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
  }), env);
}

function handlerRequest(params: Record<string, string>, body: any): CustomRequest {
  return { params, user: admin, json: async () => body } as unknown as CustomRequest;
}

function submissionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    title: 'Clubhouse Ticketing is open',
    content: FIXTURE,
    originalContent: lexical('AS SUBMITTED - must never be sent'),
    submittedBy: 'someone-else',
    submittedAt: '2026-10-05T10:00:00Z',
    status: 'approved',
    formFields: [
      { id: 'audience', label: 'Audience', value: 'Allcom', type: 'text', required: true },
      { id: 'replyToAddress', label: 'Reply-To Address', value: 'ticketing@example.org', type: 'text', required: true },
      { id: 'signatureText', label: 'Signature Text', value: 'Thanks,\nThe Ticketing Team', type: 'text', required: true },
    ],
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

let changeSeq = 0;
async function putChange(env: any, submissionId: string, change: Record<string, unknown>) {
  const id = (change.id as string) || `change-${++changeSeq}`;
  await putObject(`tracked-changes/submission/${submissionId}/${id}`, {
    id, submissionId, changedBy: 'reviewer', changedByName: 'Reviewer', timestamp: '2026-10-05T11:00:00Z',
    status: 'pending', ...change,
  }, env);
  return id;
}

describe('announcement email', () => {
  let env: any;
  let sendSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    clearMemoryCache();
    env = { STORE: createMockObjectStore(), DEV_BYPASS_AUTH: 'true', PUBLIC_URL, ANNOUNCE_EMAIL_TO: ANNOUNCE_TO };
    sendSpy = jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockImplementation(async () => ({ MessageId: 'test-message-id', $metadata: {} }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const sentInput = () => {
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const command = sendSpy.mock.calls[0][0] as SendEmailCommand;
    expect(command).toBeInstanceOf(SendEmailCommand);
    return command.input;
  };

  it('sends the rendered document with the approved subject, reply-to and signature', async () => {
    await putObject('content_submissions/sub-1', submissionRecord(), env);
    // Reviewers changed the Subject and the Reply-To, and both were accepted
    await putChange(env, 'sub-1', { field: 'title', oldValue: 'Clubhouse Ticketing is open', newValue: 'Ticketing is OPEN: claim by July 12', status: 'approved', timestamp: '2026-10-05T11:00:00Z' });
    await putChange(env, 'sub-1', { field: 'replyToAddress', oldValue: 'ticketing@example.org', newValue: 'ranger-ticketing@example.org', status: 'approved' });
    // A later Subject edit that was rejected, and one still pending: neither is approved
    await putChange(env, 'sub-1', { field: 'title', oldValue: 'x', newValue: 'Rejected subject', status: 'rejected', timestamp: '2026-10-05T12:00:00Z' });

    const response = await call(env, 'POST', '/submissions/sub-1/send-email');
    expect(response.status).toBe(200);

    const input = sentInput();
    expect(input.Destination?.ToAddresses).toEqual([ANNOUNCE_TO]);
    expect(input.ReplyToAddresses).toEqual(['ranger-ticketing@example.org']);
    expect(input.Content?.Simple?.Subject?.Data).toBe('Ticketing is OPEN: claim by July 12');

    const html = input.Content?.Simple?.Body?.Html?.Data || '';
    const text = input.Content?.Simple?.Body?.Text?.Data || '';
    expect(html).not.toContain('{"root"');
    expect(text).not.toContain('{"root"');
    expect(html).not.toContain('<h1>Comms Scribe</h1>');
    expect(html).toMatch(/<img src="https:\/\/dev\.scrivenly\.com\/api\/gallery\/1791242299248_pasted-image-1791242298889\.png"/);
    expect((html.match(/<img /g) || [])).toHaveLength(3);
    expect(html).toContain('<strong>must</strong>');
    expect(html).toContain('Thanks,<br>The Ticketing Team');
    expect(html).not.toContain('AS SUBMITTED');
    expect(text).toContain('Rangers — Ticketing Team');
    expect(text.trimEnd().endsWith('Thanks,\nThe Ticketing Team')).toBe(true);

    clearMemoryCache();
    const stored = await getObject<any>('content_submissions/sub-1', env);
    expect(stored.status).toBe('sent');
    expect(stored.announcementSent).toBe(true);
  });

  it('previews exactly what send-email sends', async () => {
    await putObject('content_submissions/sub-1', submissionRecord(), env);
    await putChange(env, 'sub-1', { field: 'signatureText', oldValue: 'Thanks,\nThe Ticketing Team', newValue: 'Love,\nRanger Ticketing', status: 'approved' });

    const previewResponse = await call(env, 'GET', '/submissions/sub-1/email-preview');
    expect(previewResponse.status).toBe(200);
    const preview: any = await previewResponse.json();
    expect(preview).toMatchObject({
      subject: 'Clubhouse Ticketing is open',
      to: ANNOUNCE_TO,
      replyTo: 'ticketing@example.org',
      audience: 'Allcom',
      signature: 'Love,\nRanger Ticketing',
    });
    expect(preview.html).toContain('Love,<br>Ranger Ticketing');

    expect((await call(env, 'POST', '/submissions/sub-1/send-email')).status).toBe(200);
    const input = sentInput();
    expect(input.Content?.Simple?.Subject?.Data).toBe(preview.subject);
    expect(input.Content?.Simple?.Body?.Html?.Data).toBe(preview.html);
    expect(input.Content?.Simple?.Body?.Text?.Data).toBe(preview.text);
    expect(input.ReplyToAddresses).toEqual([preview.replyTo]);
    expect(input.Destination?.ToAddresses).toEqual([preview.to]);
  });

  it('attaches gallery images inline so mail apps that block remote images still show them', async () => {
    await putObject('content_submissions/sub-1', submissionRecord(), env);
    const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
    await env.STORE.put('gallery/1791242299248_pasted-image-1791242298889.png', png(1));
    await env.STORE.put('gallery/1791242299134_pasted-image-1791242298889.png', png(2));
    // The third image's file is missing: it stays linked

    const preview: any = await (await call(env, 'GET', '/submissions/sub-1/email-preview')).json();
    expect(preview.html).not.toContain('cid:'); // the preview page can't show cid: images

    expect((await call(env, 'POST', '/submissions/sub-1/send-email')).status).toBe(200);
    const simple = sentInput().Content?.Simple;
    const html = simple?.Body?.Html?.Data || '';
    expect(html).toContain('<img src="cid:image1@scrivenly.com"');
    expect(html).toContain('<img src="cid:image2@scrivenly.com"');
    expect(html).toContain('<img src="https://dev.scrivenly.com/api/gallery/1791242299143_pasted-image-1791242298890.png"');
    // Everything else is what the preview shows
    expect(html.replace('cid:image1@scrivenly.com', 'https://dev.scrivenly.com/api/gallery/1791242299248_pasted-image-1791242298889.png')
      .replace('cid:image2@scrivenly.com', 'https://dev.scrivenly.com/api/gallery/1791242299134_pasted-image-1791242298889.png'))
      .toBe(preview.html);
    expect(simple?.Attachments).toEqual([
      expect.objectContaining({
        FileName: '1791242299248_pasted-image-1791242298889.png', ContentType: 'image/png', ContentDisposition: 'INLINE',
        ContentId: 'image1@scrivenly.com', ContentTransferEncoding: 'BASE64',
      }),
      expect.objectContaining({ FileName: '1791242299134_pasted-image-1791242298889.png', ContentId: 'image2@scrivenly.com' }),
    ]);
    expect(Array.from(simple!.Attachments![0].RawContent!)).toEqual(Array.from(png(1)));
  });

  it('uses the approved document: the fresh proposed document, then richTextContent, never originalContent', async () => {
    await putObject('content_submissions/sub-1', submissionRecord({
      content: 'plain text copy',
      richTextContent: lexical('Approved rich text'),
    }), env);
    let preview: any = await (await call(env, 'GET', '/submissions/sub-1/email-preview')).json();
    expect(preview.html).toContain('Approved rich text');
    expect(preview.html).not.toContain('plain text copy');
    expect(preview.html).not.toContain('AS SUBMITTED');

    // The review page's Proposed view shows the stored proposed document when no change is newer
    await putObject('proposed_versions/sub-1', {
      proposedVersionsRichText: lexical('Proposed document as reviewed'),
      lastUpdatedAt: '2026-10-05T12:00:00Z',
    }, env);
    preview = await (await call(env, 'GET', '/submissions/sub-1/email-preview')).json();
    expect(preview.html).toContain('Proposed document as reviewed');

    // ...but not when a change was made after it (GET tracked-changes ignores it then too)
    await putChange(env, 'sub-1', { field: 'content', oldValue: 'a', newValue: 'b', status: 'approved', timestamp: '2026-10-05T13:00:00Z' });
    clearMemoryCache();
    preview = await (await call(env, 'GET', '/submissions/sub-1/email-preview')).json();
    expect(preview.html).toContain('Approved rich text');
  });

  it('omits an invalid Reply-To and says so in the preview', async () => {
    await putObject('content_submissions/sub-1', submissionRecord({
      formFields: [{ id: 'replyToAddress', label: 'Reply-To Address', value: 'not an address', type: 'text', required: true }],
    }), env);
    const preview: any = await (await call(env, 'GET', '/submissions/sub-1/email-preview')).json();
    expect(preview.replyTo).toBeNull();
    expect(preview.replyToInvalid).toBe('not an address');

    expect((await call(env, 'POST', '/submissions/sub-1/send-email')).status).toBe(200);
    expect(sentInput()).not.toHaveProperty('ReplyToAddresses');
  });

  it('sends a sent announcement again only where resending is allowed (dev)', async () => {
    await putObject('content_submissions/sub-1', submissionRecord({ status: 'sent', sentAt: '2026-10-05T12:00:00Z' }), env);
    const refused = await call(env, 'POST', '/submissions/sub-1/send-email');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as any).error).toBe('Already sent');
    expect(sendSpy).not.toHaveBeenCalled();
    expect(((await (await call(env, 'GET', '/submissions/sub-1/email-preview')).json()) as any).resendAllowed).toBe(false);

    env.ALLOW_ANNOUNCEMENT_RESEND = true;
    expect(((await (await call(env, 'GET', '/submissions/sub-1/email-preview')).json()) as any).resendAllowed).toBe(true);
    expect((await call(env, 'POST', '/submissions/sub-1/send-email')).status).toBe(200);
    expect(sentInput().Destination?.ToAddresses).toEqual([ANNOUNCE_TO]);
    clearMemoryCache();
    const stored = await getObject<any>('content_submissions/sub-1', env);
    expect(stored.status).toBe('sent');
    expect(stored.sentAt).not.toBe('2026-10-05T12:00:00Z');

    // Still nothing before approval
    await putObject('content_submissions/sub-3', submissionRecord({ id: 'sub-3', status: 'in_review' }), env);
    expect((await call(env, 'POST', '/submissions/sub-3/send-email')).status).toBe(400);
  });

  it('refuses to send without ANNOUNCE_EMAIL_TO, and the preview shows no recipient', async () => {
    delete env.ANNOUNCE_EMAIL_TO;
    await putObject('content_submissions/sub-1', submissionRecord(), env);
    expect((await call(env, 'POST', '/submissions/sub-1/send-email')).status).toBe(503);
    expect(sendSpy).not.toHaveBeenCalled();
    const preview: any = await (await call(env, 'GET', '/submissions/sub-1/email-preview')).json();
    expect(preview.to).toBeNull();
  });

  it('previews for anyone who can view the submission, and no one else', async () => {
    await putObject('content_submissions/sub-1', submissionRecord({ status: 'in_review' }), env);
    expect((await call(env, 'GET', '/submissions/sub-1/email-preview', 'dev-user2-session')).status).toBe(200); // Comms Cadre
    expect((await call(env, 'GET', '/submissions/sub-1/email-preview', 'dev-member-session')).status).toBe(403);
    expect((await call(env, 'GET', '/submissions/missing/email-preview')).status).toBe(404);

    await putObject('content_submissions/sub-1', submissionRecord({ status: 'in_review', submittedBy: 'dev-member' }), env);
    expect((await call(env, 'GET', '/submissions/sub-1/email-preview', 'dev-member-session')).status).toBe(200);
    // Previewing never sends
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('approvedFieldValue / validReplyTo', () => {
  const change = (newValue: string, status: string, timestamp: string) =>
    ({ id: timestamp, submissionId: 's', field: 'title', oldValue: 'orig', newValue, status, timestamp, changedBy: 'u', changedByName: 'U' }) as any;

  it('takes the newest approved change, else the fallback', () => {
    expect(approvedFieldValue([], 'title', 'orig')).toBe('orig');
    expect(approvedFieldValue([change('pending', 'pending', '2026-01-03')], 'title', 'orig')).toBe('orig');
    expect(approvedFieldValue([
      change('first', 'approved', '2026-01-01'),
      change('second', 'approved', '2026-01-02'),
      change('rejected', 'rejected', '2026-01-03'),
    ], 'title', 'orig')).toBe('second');
    // createTrackedChange stores the changed words in newValue and the whole value apart
    expect(approvedFieldValue([
      { ...change('subject', 'approved', '2026-01-01'), completeProposedVersion: 'New subject' },
    ], 'title', 'orig')).toBe('New subject');
  });

  it('accepts bare and named addresses only', () => {
    expect(validReplyTo(' a@example.org ')).toBe('a@example.org');
    expect(validReplyTo('Ticketing Team <a@example.org>')).toBe('Ticketing Team <a@example.org>');
    expect(validReplyTo('a@example')).toBeNull();
    expect(validReplyTo('a@example.org\r\nBcc: x@example.org')).toBeNull();
    expect(validReplyTo('two@example.org, three@example.org')).toBeNull();
  });
});

/**
 * Accepting or rejecting a form-field change (Subject, Reply-To, ...) used to run the document
 * recompute for that field: an accept wrote the new Subject over content / richTextContent,
 * and a reject restored the as-submitted document over every accepted edit.
 */
describe('resolving a form-field change leaves the document alone', () => {
  let env: any;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    clearMemoryCache();
    env = { STORE: createMockObjectStore(), DEV_BYPASS_AUTH: 'true' };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function setUp() {
    const original = lexical('Original body');
    const edited = lexical('Edited body');
    await putObject('content_submissions/sub-2', submissionRecord({
      id: 'sub-2', status: 'in_review', title: 'Old subject', content: original, richTextContent: original,
    }), env);
    // An accepted body edit
    const created = await createTrackedChangeHandler(handlerRequest({ submissionId: 'sub-2' }, {
      field: 'content', oldValue: 'Original body', newValue: 'Edited body', richTextOldValue: original, richTextNewValue: edited,
    }), env);
    const bodyChange: any = await created.json();
    expect((await updateChangeStatusHandler(handlerRequest({ changeId: bodyChange.id }, { status: 'approved', submissionId: 'sub-2' }), env)).status).toBe(200);
    clearMemoryCache();
    expect((await getObject<any>('content_submissions/sub-2', env)).richTextContent).toBe(edited);
    return { edited };
  }

  async function titleChange(newValue: string): Promise<string> {
    const response = await createTrackedChangeHandler(handlerRequest({ submissionId: 'sub-2' }, {
      field: 'title', oldValue: 'Old subject', newValue,
    }), env);
    return ((await response.json()) as any).id;
  }

  it('on accept', async () => {
    const { edited } = await setUp();
    const id = await titleChange('New subject');
    expect((await updateChangeStatusHandler(handlerRequest({ changeId: id }, { status: 'approved', submissionId: 'sub-2' }), env)).status).toBe(200);
    clearMemoryCache();
    const after = await getObject<any>('content_submissions/sub-2', env);
    expect(after.richTextContent).toBe(edited);
    expect(after.content).toBe('Edited body');
    expect(after.title).toBe('Old subject'); // the record keeps the as-submitted value

    const preview: any = await (await call(env, 'GET', '/submissions/sub-2/email-preview')).json();
    expect(preview.subject).toBe('New subject');
    expect(preview.html).toContain('Edited body');
  });

  it('on reject', async () => {
    const { edited } = await setUp();
    const id = await titleChange('Rejected subject');
    expect((await updateChangeStatusHandler(handlerRequest({ changeId: id }, { status: 'rejected', submissionId: 'sub-2' }), env)).status).toBe(200);
    clearMemoryCache();
    const after = await getObject<any>('content_submissions/sub-2', env);
    expect(after.richTextContent).toBe(edited);
    expect(after.content).toBe('Edited body');
    const preview: any = await (await call(env, 'GET', '/submissions/sub-2/email-preview')).json();
    expect(preview.subject).toBe('Old subject');
  });

  async function proposedTitle(): Promise<string | undefined> {
    clearMemoryCache();
    const response = await getTrackedChangesHandler(handlerRequest({ submissionId: 'sub-2' }, {}), env);
    return ((await response.json()) as any).proposedVersions.title;
  }

  it('shows the accepted subject as the proposed one, and the submitted one after a reject', async () => {
    await setUp();
    const accepted = await titleChange('New subject');
    expect(await proposedTitle()).toBe('New subject'); // pending
    await updateChangeStatusHandler(handlerRequest({ changeId: accepted }, { status: 'approved', submissionId: 'sub-2' }), env);
    expect(await proposedTitle()).toBe('New subject'); // accepted: still the proposed subject

    const rejected = await titleChange('Rejected subject');
    expect(await proposedTitle()).toBe('Rejected subject');
    await updateChangeStatusHandler(handlerRequest({ changeId: rejected }, { status: 'rejected', submissionId: 'sub-2' }), env);
    expect(await proposedTitle()).toBe('New subject'); // back to the accepted one

    await updateChangeStatusHandler(handlerRequest({ changeId: accepted }, { status: 'rejected', submissionId: 'sub-2' }), env);
    expect(await proposedTitle()).toBeUndefined(); // the submitted subject stands
  });

  it('keeps the cached proposed document when a form field changes', async () => {
    await setUp();
    await putObject('proposed_versions/sub-2', {
      proposedVersionsRichText: lexical('Cached body'), proposedVersionsContent: 'Cached body',
      lastUpdatedAt: new Date().toISOString(),
    }, env);
    await titleChange('New subject');
    clearMemoryCache();
    expect(await getObject<any>('proposed_versions/sub-2', env)).not.toBeNull();
    const response = await getTrackedChangesHandler(handlerRequest({ submissionId: 'sub-2' }, {}), env);
    expect(((await response.json()) as any).proposedVersions.content).toBe('Cached body');
  });

  it('in a batch', async () => {
    const { edited } = await setUp();
    const id = await titleChange('Batch subject');
    const response = await batchUpdateStatusHandler(handlerRequest({}, { changeIds: [id], status: 'approved', submissionId: 'sub-2' }), env);
    expect(response.status).toBe(200);
    clearMemoryCache();
    const after = await getObject<any>('content_submissions/sub-2', env);
    expect(after.richTextContent).toBe(edited);
    const preview: any = await (await call(env, 'GET', '/submissions/sub-2/email-preview')).json();
    expect(preview.subject).toBe('Batch subject');
  });
});

describe('embedGalleryImages', () => {
  const env = () => ({ STORE: createMockObjectStore(), PUBLIC_URL } as any);
  const img = (src: string) => `<p><img src="${src}" alt="" width="10" style="display:block;"></p>`;

  it('embeds each gallery file once, using the variant asked for or the original', async () => {
    const e = env();
    await e.STORE.put('gallery/a.png', new Uint8Array([1]));
    await e.STORE.put('gallery/medium/b.jpg', new Uint8Array([2]));
    const html = img('https://dev.scrivenly.com/api/gallery/a.png') + img('https://dev.scrivenly.com/api/gallery/a.png/thumbnail')
      + img('https://dev.scrivenly.com/api/gallery/b.jpg/medium') + img('https://dev.scrivenly.com/api/gallery/a.png');
    const result = await embedGalleryImages(html, e);
    expect(result.attachments.map((a) => [a.fileName, a.contentType, a.contentId])).toEqual([
      ['a.png', 'image/png', 'image1@scrivenly.com'],
      ['a.png', 'image/png', 'image2@scrivenly.com'], // the thumbnail falls back to the original
      ['b.jpg', 'image/jpeg', 'image3@scrivenly.com'],
    ]);
    expect(result.html.match(/cid:image1@scrivenly\.com/g)).toHaveLength(2);
  });

  it('leaves other sites, SVG, query strings and path tricks linked', async () => {
    const e = env();
    await e.STORE.put('gallery/a.svg', new Uint8Array([1]));
    await e.STORE.put('gallery/a.png', new Uint8Array([1]));
    const html = img('https://example.org/api/gallery/a.png') + img('https://dev.scrivenly.com/api/gallery/a.svg')
      + img('https://dev.scrivenly.com/api/gallery/a.png?x=1') + img('https://dev.scrivenly.com/api/gallery/..%2Fsession%2Fx.png');
    const result = await embedGalleryImages(html, e);
    expect(result.attachments).toEqual([]);
    expect(result.html).toBe(html);
  });
});
