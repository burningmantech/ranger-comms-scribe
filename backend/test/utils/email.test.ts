import { sendEmail } from '../../src/utils/email';
import { AwsClient } from 'aws4fetch';

// Mock aws4fetch
jest.mock('aws4fetch', () => {
  return {
    AwsClient: jest.fn().mockImplementation(() => {
      return {
        fetch: jest.fn().mockResolvedValue({
          status: 200,
          statusText: 'OK',
          json: jest.fn().mockResolvedValue({ MessageId: 'test-message-id' })
        })
      };
    })
  };
});

describe('Email Utility', () => {
  // Spy on console.log to prevent test output noise and check its calls
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('sendEmail', () => {
    it('should send an email successfully', async () => {
      const toEmail = 'test@example.com';
      const subject = 'Test Subject';
      const message = 'Test message content';
      const accessKey = 'test-access-key';
      const secretKey = 'test-secret-key';
      
      const result = await sendEmail(toEmail, subject, message, accessKey, secretKey);
      
      // Verify result
      expect(result).toBe(200);
      
      // Verify AWS client was initialized with correct credentials
      expect(AwsClient).toHaveBeenCalledWith({
        accessKeyId: accessKey,
        secretAccessKey: secretKey
      });
      
      // Get the fetch mock to verify its calls
      const awsClientInstance = (AwsClient as jest.Mock).mock.results[0].value;
      
      // Verify fetch was called with correct parameters
      expect(awsClientInstance.fetch).toHaveBeenCalledWith(
        'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'content-type': 'application/json'
          })
        })
      );
      
      // Verify email content in the request body
      const fetchCall = awsClientInstance.fetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body as string);
      
      expect(requestBody.Destination.ToAddresses).toContain(toEmail);
      expect(requestBody.Content.Simple.Subject.Data).toBe(subject);
      expect(requestBody.Content.Simple.Body.Text.Data).toBe(message);
      expect(requestBody.Content.Simple.Body.Html.Data).toContain(message);
      
      // Verify logs were called
      expect(console.log).toHaveBeenCalledTimes(2);
    });
    
    it('should format HTML and plaintext correctly', async () => {
      const toEmail = 'test@example.com';
      const subject = 'Test Subject';
      const message = 'Line 1<br>Line 2<br/>Line 3<br />Line 4';
      const accessKey = 'test-access-key';
      const secretKey = 'test-secret-key';
      
      await sendEmail(toEmail, subject, message, accessKey, secretKey);
      
      // Get the fetch mock to verify the request body
      const awsClientInstance = (AwsClient as jest.Mock).mock.results[0].value;
      const fetchCall = awsClientInstance.fetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body as string);
      
      // Plain text should have <br> tags converted to newlines
      expect(requestBody.Content.Simple.Body.Text.Data).toBe('Line 1\nLine 2\nLine 3\nLine 4');
      
      // HTML should have newlines converted to <br> tags
      // The original has <br> tags already, so we're just verifying it contains the message
      expect(requestBody.Content.Simple.Body.Html.Data).toContain(message);
    });
    
    it('should throw an error when SES request fails', async () => {
      // Override the mock to simulate a failed request
      const mockFetch = jest.fn().mockResolvedValue({
        status: 400,
        statusText: 'Bad Request',
        json: jest.fn().mockResolvedValue({ Error: 'Invalid parameters' })
      });
      
      (AwsClient as jest.Mock).mockImplementation(() => {
        return { fetch: mockFetch };
      });
      
      const toEmail = 'test@example.com';
      const subject = 'Test Subject';
      const message = 'Test message content';
      const accessKey = 'test-access-key';
      const secretKey = 'test-secret-key';
      
      await expect(sendEmail(toEmail, subject, message, accessKey, secretKey))
        .rejects
        .toThrow('Error sending email: 400 Bad Request');
    });
  });
});