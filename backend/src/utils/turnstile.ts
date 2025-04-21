import { Env } from './sessionManager';

/**
 * Verifies a Cloudflare Turnstile token
 * 
 * @param token The Turnstile token to verify
 * @param remoteip Optional IP address of the user
 * @param env Environment containing the Turnstile secret
 * @returns Whether the token is valid
 */
export async function verifyTurnstileToken(token: string, remoteip: string | null, env: Env): Promise<boolean> {
  try {
    if (!token) return false;
    
    const secretKey = env.TURNSTILESECRET;
    if (!secretKey) {
      console.error("Turnstile secret key is not configured");
      return false;
    }

    const formData = new FormData();
    formData.append('secret', secretKey);
    formData.append('response', token);
    if (remoteip) formData.append('remoteip', remoteip);

    const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    const result = await fetch(url, {
      body: formData,
      method: 'POST',
    });

    const outcome = await result.json();
    return outcome.success;
  } catch (error) {
    console.error('Error verifying Turnstile token:', error);
    return false;
  }
}