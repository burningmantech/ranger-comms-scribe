import { verifyGoogleIdToken } from '../../src/utils/googleToken';

const CLIENT_ID = 'our-client.apps.googleusercontent.com';

const validPayload = {
  aud: CLIENT_ID,
  iss: 'https://accounts.google.com',
  email: 'ranger@example.com',
  email_verified: 'true',
  name: 'Test Ranger',
  sub: '1234567890',
};

function mockTokeninfo(body: Record<string, unknown>, ok = true) {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok,
    json: jest.fn().mockResolvedValue(body),
  });
}

describe('verifyGoogleIdToken', () => {
  const originalFetch = (global as any).fetch;

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it('returns the identity for a token issued to our client', async () => {
    mockTokeninfo(validPayload);

    await expect(verifyGoogleIdToken('tok', CLIENT_ID)).resolves.toEqual({
      email: 'ranger@example.com',
      name: 'Test Ranger',
      sub: '1234567890',
    });
  });

  it('URL-encodes the token when calling tokeninfo', async () => {
    mockTokeninfo(validPayload);

    await verifyGoogleIdToken('a+b/c=&x', CLIENT_ID);

    expect((global as any).fetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/tokeninfo?id_token=a%2Bb%2Fc%3D%26x'
    );
  });

  it('rejects a token issued to a different client', async () => {
    mockTokeninfo({ ...validPayload, aud: 'some-other-app.apps.googleusercontent.com' });

    await expect(verifyGoogleIdToken('tok', CLIENT_ID)).rejects.toThrow('audience');
  });

  it('rejects a token from an unexpected issuer', async () => {
    mockTokeninfo({ ...validPayload, iss: 'https://evil.example.com' });

    await expect(verifyGoogleIdToken('tok', CLIENT_ID)).rejects.toThrow('issuer');
  });

  it('rejects an unverified email', async () => {
    mockTokeninfo({ ...validPayload, email_verified: 'false' });

    await expect(verifyGoogleIdToken('tok', CLIENT_ID)).rejects.toThrow('not verified');
  });

  it('accepts the bare accounts.google.com issuer and a boolean email_verified', async () => {
    mockTokeninfo({ ...validPayload, iss: 'accounts.google.com', email_verified: true });

    await expect(verifyGoogleIdToken('tok', CLIENT_ID)).resolves.toMatchObject({
      email: 'ranger@example.com',
    });
  });

  it('rejects when tokeninfo says the token is invalid', async () => {
    mockTokeninfo({ error: 'invalid_token' }, false);

    await expect(verifyGoogleIdToken('tok', CLIENT_ID)).rejects.toThrow('Invalid token');
  });

  it('fails closed when no client ID is configured', async () => {
    mockTokeninfo(validPayload);

    await expect(verifyGoogleIdToken('tok', undefined)).rejects.toThrow('not configured');
    expect((global as any).fetch).not.toHaveBeenCalled();
  });
});
