import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { sendEmail, sendReplyNotification, DEFAULT_EMAIL_FROM } from '../../src/utils/email';

describe('Email Utility', () => {
  let sendSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    sendSpy = jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockImplementation(async () => ({ MessageId: 'test-message-id', $metadata: {} }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const lastInput = () => {
    const command = sendSpy.mock.calls[sendSpy.mock.calls.length - 1][0] as SendEmailCommand;
    expect(command).toBeInstanceOf(SendEmailCommand);
    return command.input;
  };

  describe('sendEmail', () => {
    it('sends through SES v2 with the configured From and BCC', async () => {
      const result = await sendEmail('test@example.com', 'Test Subject', 'Line one\nLine two', {
        EMAIL_FROM: 'Scribe <noreply@example.org>',
        EMAIL_BCC: ['audit@example.org', 'copy@example.org'],
        SES_REGION: 'us-west-2',
      });

      expect(result).toBe(200);
      expect(sendSpy).toHaveBeenCalledTimes(1);

      const input = lastInput();
      expect(input.FromEmailAddress).toBe('Scribe <noreply@example.org>');
      expect(input.Destination).toEqual({
        ToAddresses: ['test@example.com'],
        BccAddresses: ['audit@example.org', 'copy@example.org'],
      });
      expect(input.Content?.Simple?.Subject?.Data).toBe('Test Subject');
      expect(input.Content?.Simple?.Body?.Html?.Data).toContain('<h1>Comms Scribe</h1>');
      expect(input.Content?.Simple?.Body?.Html?.Data).toContain('Line one<br>Line two');
    });

    it('uses the SES region from config', async () => {
      await sendEmail('a@example.com', 'S', 'M', { SES_REGION: 'eu-west-1' });
      const client = sendSpy.mock.instances[0] as SESv2Client;
      expect(await client.config.region()).toBe('eu-west-1');
    });

    it('omits BccAddresses when EMAIL_BCC is empty', async () => {
      await sendEmail('test@example.com', 'Subject', 'Body', { EMAIL_BCC: [] });
      const input = lastInput();
      expect(input.Destination).toEqual({ ToAddresses: ['test@example.com'] });
      expect(input.Destination).not.toHaveProperty('BccAddresses');
    });

    it('defaults the From address', async () => {
      await sendEmail('test@example.com', 'Subject', 'Body', {});
      expect(lastInput().FromEmailAddress).toBe(DEFAULT_EMAIL_FROM);
      expect(lastInput().Destination).not.toHaveProperty('BccAddresses');
    });

    it('turns <br> tags into newlines in the text body', async () => {
      await sendEmail('test@example.com', 'Subject', 'Hello<br>World<br/>Again<br />Done', {});
      expect(lastInput().Content?.Simple?.Body?.Text?.Data).toBe('Hello\nWorld\nAgain\nDone');
    });

    it('throws when SES rejects the send', async () => {
      sendSpy.mockRejectedValueOnce(Object.assign(new Error('Email address is not verified.'), { name: 'MessageRejected' }));
      await expect(sendEmail('test@example.com', 'Subject', 'Body', {}))
        .rejects.toThrow('Error sending email: MessageRejected: Email address is not verified.');
    });
  });

  describe('sendReplyNotification', () => {
    it('builds the reply email and passes config through', async () => {
      await sendReplyNotification('author@example.com', 'Replier', 'post', 'Nice post', 'https://x.test/blog', {
        EMAIL_FROM: 'Scribe <noreply@example.org>',
      });
      const input = lastInput();
      expect(input.Destination?.ToAddresses).toEqual(['author@example.com']);
      expect(input.FromEmailAddress).toBe('Scribe <noreply@example.org>');
      expect(input.Content?.Simple?.Subject?.Data).toBe('New Reply from Replier on Comms Scribe');
      expect(input.Content?.Simple?.Body?.Text?.Data).toContain('https://x.test/blog');
    });
  });
});
