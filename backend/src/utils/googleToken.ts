/**
 * Verifies a Google ID token from Google Sign-In / One Tap.
 *
 * Google's tokeninfo endpoint checks the signature and expiry. We must also
 * check that the token was issued to OUR OAuth client (`aud`) and by Google
 * (`iss`); otherwise a valid ID token minted for any other app would let its
 * holder sign in here as that Google user.
 */

export interface GoogleTokenPayload {
  email: string;
  name: string;
  sub: string;
}

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export async function verifyGoogleIdToken(
  token: string,
  expectedClientId: string | undefined
): Promise<GoogleTokenPayload> {
  if (!expectedClientId) {
    // Fail closed: without a configured client ID we cannot check the audience.
    throw new Error('GOOGLE_CLIENT_ID is not configured');
  }

  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`
  );
  if (!response.ok) {
    throw new Error('Invalid token');
  }

  const payload = (await response.json()) as {
    aud?: string;
    iss?: string;
    email?: string;
    email_verified?: string | boolean;
    name?: string;
    sub?: string;
  };

  if (payload.aud !== expectedClientId) {
    throw new Error('Token audience mismatch');
  }
  if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
    throw new Error('Token issuer mismatch');
  }
  // tokeninfo returns email_verified as the string "true"
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new Error('Google account email is not verified');
  }
  if (!payload.email || !payload.sub) {
    throw new Error('Token is missing email or subject');
  }

  return { email: payload.email, name: payload.name || payload.email, sub: payload.sub };
}
