import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';
import { clearMemoryCache } from '../../src/services/cacheService';
import {
  formatPublishBy,
  renderWorkflowEmail,
  requestDetails,
  requestLink,
  sendWorkflowEmail,
} from '../../src/services/workflowEmail';

describe('workflow email', () => {
  let sendSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    clearMemoryCache();
    sendSpy = jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockImplementation(async () => ({ MessageId: 'id', $metadata: {} }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const lastInput = () => (sendSpy.mock.calls[sendSpy.mock.calls.length - 1][0] as SendEmailCommand).input;

  describe('requestLink', () => {
    it('is the review page on the site origin', () => {
      expect(requestLink({ FRONTEND_URL: 'https://scrivenly.com/app', PUBLIC_URL: 'https://x.test/api' }, 's1')).toBe('https://scrivenly.com/tracked-changes/s1');
      expect(requestLink({ PUBLIC_URL: 'https://x.test/api' }, 's1')).toBe('https://x.test/tracked-changes/s1');
    });
  });

  describe('renderWorkflowEmail', () => {
    const email = {
      heading: 'Your approval is needed',
      paragraphs: ['Sam asked for your approval.'],
      details: [{ label: 'Publish by', value: 'Fri, Oct 9' }],
      action: { label: 'Open the request', url: 'https://scrivenly.com/tracked-changes/s1' },
    };

    it('renders the same content as HTML and plain text', () => {
      const { html, text } = renderWorkflowEmail(email);
      expect(html).toContain('Your approval is needed');
      expect(html).toContain('Sam asked for your approval.');
      expect(html).toContain('Publish by');
      expect(html).toContain('href="https://scrivenly.com/tracked-changes/s1"');
      expect(html).toContain('max-width:560px');
      expect(text).toContain('Your approval is needed');
      expect(text).toContain('Sam asked for your approval.');
      expect(text).toContain('Publish by: Fri, Oct 9');
      expect(text).toContain('Open the request: https://scrivenly.com/tracked-changes/s1');
      expect(text).not.toContain('<');
    });

    it('escapes every interpolated value', () => {
      const evil = '<script>alert("x")</script> & "q"';
      const { html, text } = renderWorkflowEmail({
        heading: evil,
        paragraphs: [evil],
        details: [{ label: evil, value: evil }],
        items: [{ title: evil, lines: [evil], link: 'https://scrivenly.com/a?x=1&y="2"' }],
        action: { label: evil, url: 'https://scrivenly.com/?a="b"' },
        footer: evil,
      });
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&amp;');
      expect(html).not.toContain('href="https://scrivenly.com/a?x=1&y="2""');
      expect(html).toContain('x=1&amp;y=&quot;2&quot;');
      // The text version is plain text: not escaped
      expect(text).toContain(evil);
    });

    it('refuses links that are not web links', () => {
      const { html } = renderWorkflowEmail({
        heading: 'H',
        paragraphs: [],
        items: [{ title: 'Item', lines: [], link: 'javascript:alert(1)' }],
        action: { label: 'Go', url: 'javascript:alert(1)' },
      });
      expect(html).not.toContain('javascript:');
    });

    it('lists items with their lines and links', () => {
      const { html, text } = renderWorkflowEmail({
        heading: 'Waiting on you',
        paragraphs: ['Two requests.'],
        items: [
          { title: 'Gate shifts', lines: ['Waiting 3 days'], link: 'https://scrivenly.com/tracked-changes/a' },
          { title: 'Camp rules', lines: ['Waiting 1 day', 'Publish by Fri, Oct 9'], link: 'https://scrivenly.com/tracked-changes/b' },
        ],
      });
      expect(html).toContain('>Gate shifts</a>');
      expect(html).toContain('Publish by Fri, Oct 9');
      expect(text).toContain('Gate shifts\n  Waiting 3 days\n  https://scrivenly.com/tracked-changes/a');
      expect(text).toContain('Camp rules\n  Waiting 1 day\n  Publish by Fri, Oct 9\n  https://scrivenly.com/tracked-changes/b');
    });

    it('has a default footer linking to the site, and takes a custom one', () => {
      const plain = renderWorkflowEmail({ heading: 'H', paragraphs: [] });
      expect(plain.text).toContain('Comms Scribe · https://scrivenly.com');
      expect(plain.html).toContain('href="https://scrivenly.com"');
      const custom = renderWorkflowEmail({ heading: 'H', paragraphs: [], footer: 'Sent by Scribe' });
      expect(custom.text).toContain('Sent by Scribe');
      expect(custom.html).toContain('Sent by Scribe');
    });

    it('skips details with no value', () => {
      const { html, text } = renderWorkflowEmail({ heading: 'H', paragraphs: [], details: [{ label: 'Empty', value: '' }] });
      expect(html).not.toContain('Empty');
      expect(text).not.toContain('Empty');
    });
  });

  describe('sendWorkflowEmail', () => {
    const rendered = renderWorkflowEmail({ heading: 'H', paragraphs: ['P'] });

    it('sends the HTML and text to the recipients', async () => {
      await sendWorkflowEmail({ STORE: new MemoryObjectStore() }, ['a@x.org', 'b@x.org'], 'Subject', rendered, { replyTo: 'sam@x.org' });
      const input = lastInput();
      expect(input.Destination?.ToAddresses).toEqual(['a@x.org', 'b@x.org']);
      expect(input.Content?.Simple?.Subject?.Data).toBe('Subject');
      expect(input.Content?.Simple?.Body?.Html?.Data).toBe(rendered.html);
      expect(input.Content?.Simple?.Body?.Text?.Data).toBe(rendered.text);
      expect(input.ReplyToAddresses).toEqual(['sam@x.org']);
    });

    it('sends only to COMMS_EMAIL_OVERRIDE when it is set', async () => {
      await sendWorkflowEmail({ STORE: new MemoryObjectStore(), COMMS_EMAIL_OVERRIDE: 'test@dev.org' }, ['a@x.org', 'b@x.org'], 'Subject', rendered);
      const input = lastInput();
      expect(input.Destination?.ToAddresses).toEqual(['test@dev.org']);
      expect(input.Content?.Simple?.Subject?.Data).toBe('[for a@x.org, b@x.org] Subject');
    });

    it('sends nothing when there is nobody to send to', async () => {
      await sendWorkflowEmail({ STORE: new MemoryObjectStore() }, [], 'Subject', rendered);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('throws when SES fails', async () => {
      sendSpy.mockRejectedValueOnce(new Error('throttled'));
      await expect(sendWorkflowEmail({ STORE: new MemoryObjectStore() }, ['a@x.org'], 'S', rendered)).rejects.toThrow(/throttled/);
    });
  });

  describe('requestDetails', () => {
    it('lists submitter, Publish By and audiences, skipping what is missing', async () => {
      const env: any = { STORE: new MemoryObjectStore() };
      await env.STORE.put('user/sam@x.org', JSON.stringify({ id: 'id-sam', email: 'sam@x.org', name: 'Sam Ranger' }));
      const submission: any = {
        id: 's1',
        submittedBy: 'id-sam',
        formFields: [{ id: 'publishBy', label: 'Publish By', value: '2026-10-09' }],
        audiences: ['newsletter', 'allcom'],
      };
      await env.STORE.put('user-by-id/id-sam', JSON.stringify({ email: 'sam@x.org' }));
      expect(await requestDetails(submission, env)).toEqual([
        { label: 'Submitted by', value: 'Sam Ranger' },
        { label: 'Publish by', value: 'Fri, Oct 9' },
        { label: 'Audience', value: 'Include in Ranger Newsletter (sent over Ranger Announce), Allcom' },
      ]);

      expect(await requestDetails({ id: 's2', submittedBy: '', formFields: [] } as any, env)).toEqual([]);
    });
  });

  describe('formatPublishBy', () => {
    it('formats a date and passes anything else through', () => {
      expect(formatPublishBy('2026-10-09')).toBe('Fri, Oct 9');
      expect(formatPublishBy('2026-10-09T00:00:00.000Z')).toBe('Fri, Oct 9');
      expect(formatPublishBy('soon')).toBe('soon');
    });
  });
});
