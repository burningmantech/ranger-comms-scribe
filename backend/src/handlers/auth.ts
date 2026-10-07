import { accessOf, accessView, derivedUserType, publicUser } from '../services/access';
import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { zxcvbn } from '@zxcvbn-ts/core';
import { CreateSession, DeleteSession, GetSession, Env } from '../utils/sessionManager';
import { getUser, getUserStrict, getOrCreateUser, authenticateUser, setUserPassword, markUserAsVerified, applyBootstrapAdmin, markVerifiedByGoogle, promoteAfterEmailVerification } from '../services/userService';
import { User } from '../types';
import { sendEmail } from '../utils/email';
import { verifyTurnstileToken } from '../utils/turnstile';
import { verifyGoogleIdToken } from '../utils/googleToken';
import { getClientIp } from '../utils/clientIp';
import { getDevUserForRequest } from '../utils/devUsers';
import { withAdminCheck } from '../authWrappers';

export const router = AutoRouter({ base : '/api/auth' });

// Helper: create a session for a user and return the session ID
async function createUserSession(user: User, env: Env): Promise<string> {
  return CreateSession(user.email, {
    email: user.email,
    name: user.name,
    isAdmin: accessOf(user, env).isAdmin,
    userType: derivedUserType(accessOf(user, env)),
    verified: user.verified
  }, env);
}

// Helper: create a token, store it in the object store, and return the token string
async function createAndStoreToken(
  userId: string,
  tokenType: 'verification-token' | 'reset-token',
  expirationMs: number,
  env: Env
): Promise<string> {
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + expirationMs;

  await env.STORE.put(`${tokenType}/${token}`, JSON.stringify({ userId, expiresAt }), {
    contentType: 'application/json',
    metadata: { userId }
  });

  return token;
}

// Helper: validate a token from the object store, return data or null
async function validateToken(
  token: string,
  tokenType: 'verification-token' | 'reset-token',
  env: Env
): Promise<{ userId: string; expiresAt: number } | null> {
  const tokenObj = await env.STORE.get(`${tokenType}/${token}`);
  if (!tokenObj) return null;

  const tokenData = await tokenObj.json() as { userId: string; expiresAt: number };
  if (tokenData.expiresAt < Date.now()) {
    await env.STORE.delete(`${tokenType}/${token}`);
    return null;
  }

  return tokenData;
}

// Helper: build a frontend URL for a token action
function buildTokenUrl(token: string, route: string, env: Env): string {
  const frontendUrl = env.FRONTEND_URL || env.PUBLIC_URL || 'https://scrivenly.com';
  return `${frontendUrl}/${route}?token=${token}`;
}

// Helper: send an email through SES, return success boolean
async function sendEmailIfConfigured(
  to: string, subject: string, message: string, env: Env
): Promise<boolean> {
  try {
    await sendEmail(to, subject, message, env);
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

// Helper: when an email could not be sent, local development (DEV_BYPASS_AUTH)
// gets the token back for convenience. Deployed environments never do: a failed
// send (e.g. SES still in sandbox) must not hand out reset/verification tokens.
function debugToken(token: string, env: Env): { debug?: string } {
  return env.DEV_BYPASS_AUTH === 'true' ? { debug: 'Email not sent - token: ' + token } : {};
}

// Helper function to validate password strength
const validatePassword = (password: string): { valid: boolean; message: string } => {
    const result = zxcvbn(password);
    
    // Require minimum score of 3 out of 4
    if (result.score < 3) {
        return {
            valid: false,
            message: `Password is too weak. ${result.feedback.warning}. Suggestions: ${result.feedback.suggestions.join(', ')}`
        };
    }

    // Additional requirements
    if (password.length < 8) {
        return { valid: false, message: 'Password must be at least 8 characters long' };
    }

    if (!/[A-Z]/.test(password)) {
        return { valid: false, message: 'Password must contain at least one uppercase letter' };
    }

    if (!/[a-z]/.test(password)) {
        return { valid: false, message: 'Password must contain at least one lowercase letter' };
    }

    if (!/[0-9]/.test(password)) {
        return { valid: false, message: 'Password must contain at least one number' };
    }

    if (!/[^A-Za-z0-9]/.test(password)) {
        return { valid: false, message: 'Password must contain at least one special character' };
    }

    return { valid: true, message: 'Password meets requirements' };
}

// Register a new user with email and password
router.post('/register', async (request: Request, env) => {
    console.log('POST /auth/register called');
    const body = await request.json() as { name: string; email: string; password: string; turnstileToken: string };
    const { name, email, password, turnstileToken } = body;

    if (!name || !email || !password) {
        return json({ error: 'Name, email and password are required' }, { status: 400 });
    }

    if (!turnstileToken) {
        return json({ error: 'Turnstile verification failed' }, { status: 400 });
    }

    // Verify Turnstile token
    const clientIp = getClientIp(request);
    const isTurnstileValid = await verifyTurnstileToken(turnstileToken, clientIp, env);
    if (!isTurnstileValid) {
        return json({ error: 'Turnstile verification failed' }, { status: 400 });
    }

    // Validate password strength
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
        return json({ error: passwordValidation.message }, { status: 400 });
    }

    try {
        // Check if user with this email already exists. This must include users
        // without a password (Google sign-in or admin-created): getOrCreateUser
        // returns an existing user unchanged, so registering their email would
        // otherwise hand out a session for their account without any credential.
        // Strict: a store error answers 500 below instead of looking like "no user".
        const existingUser = await getUserStrict(email, env);
        if (existingUser) {
            return json({ error: 'User with this email already exists' }, { status: 409 });
        }

        // Create the user with password. Not promoted to bootstrap admin here: the
        // address is unproven until /verify-email (see applyBootstrapAdmin).
        const user = await getOrCreateUser({ name, email, password }, env);

        if (!user.verified) {
            // Generate and store verification token
            const verificationToken = await createAndStoreToken(user.id, 'verification-token', 86400000, env);
            const verificationUrl = buildTokenUrl(verificationToken, 'verify-email', env);

            // Send verification email
            await sendEmailIfConfigured(user.email, 'Verify Your Email', `
            <h1>Welcome to our platform!</h1>
            <p>Hello ${user.name},</p>
            <p>Thank you for registering. Please click the link below to verify your email address:</p>
            <p><a href="${verificationUrl}">Verify Email</a></p>
            <p>This link will expire in 24 hours.</p>
        `, env);
        }

        const sessionId = await createUserSession(user, env);

        return json({
            message: 'User registered successfully. Please check your email to verify your account.',
            email,
            name,
            userId: user.email,
            isAdmin: accessOf(user, env).isAdmin,
            verified: !!user.verified,
            sessionId,
        });
    } catch (error) {
        console.error('Error registering user:', error);
        return json({ error: 'Failed to register user' }, { status: 500 });
    }
});

// Verify email
router.post('/verify-email', async (request: Request, env) => {
    console.log('POST /auth/verify-email called');
    const body = await request.json() as { token: string };
    const { token } = body;

    if (!token) {
        return json({ error: 'Verification token is required' }, { status: 400 });
    }

    try {
        const tokenData = await validateToken(token, 'verification-token', env);
        if (!tokenData) {
            return json({ error: 'Invalid or expired verification token' }, { status: 400 });
        }

        // Mark user as verified. A bootstrap admin is promoted now that the address is
        // proven, with any password cleared (see promoteAfterEmailVerification).
        const user = await markUserAsVerified(tokenData.userId, env);
        if (!user) {
            return json({ error: 'Failed to verify user' }, { status: 500 });
        }
        await promoteAfterEmailVerification(user, env);

        // Delete the used token
        await env.STORE.delete(`verification-token/${token}`);

        return json({ message: 'Email verification successful', verified: true });
    } catch (error) {
        console.error('Error verifying email:', error);
        return json({ error: 'Failed to verify email' }, { status: 500 });
    }
});

// Resend verification email
router.post('/resend-verification', async (request: Request, env) => {
    console.log('POST /auth/resend-verification called');
    
    // Verify session
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!sessionId) {
        return json({ error: 'Session ID is required' }, { status: 400 });
    }

    const session = await GetSession(sessionId, env);
    if (!session) {
        return json({ error: 'Session not found or expired' }, { status: 403 });
    }

    try {
        // Get user
        const user = await getUser(session.userId, env);
        if (!user) {
            return json({ error: 'User not found' }, { status: 404 });
        }

        // Check if already verified
        if (user.verified) {
            return json({ error: 'Email is already verified' }, { status: 400 });
        }

        // Generate new verification token
        const verificationToken = await createAndStoreToken(user.id, 'verification-token', 86400000, env);
        const verificationUrl = buildTokenUrl(verificationToken, 'verify-email', env);

        // Send verification email
        const sent = await sendEmailIfConfigured(user.email, 'Verify Your Email', `
            <h1>Email Verification</h1>
            <p>Hello ${user.name},</p>
            <p>Please click the link below to verify your email address:</p>
            <p><a href="${verificationUrl}">Verify Email</a></p>
            <p>This link will expire in 24 hours.</p>
        `, env);

        if (!sent) {
            return json({
                message: 'Verification email would have been sent.',
                ...debugToken(verificationToken, env)
            });
        }

        return json({ message: 'Verification email has been sent' });
    } catch (error) {
        console.error('Error resending verification email:', error);
        return json({ error: 'Failed to resend verification email' }, { status: 500 });
    }
});

// Login with email and password
router.post('/login', async (request: Request, env) => {
    console.log('POST /auth/login called');
    const body = await request.json() as { email: string; password: string; turnstileToken: string };
    const { email, password, turnstileToken } = body;

    if (!email || !password) {
        return json({ error: 'Email and password are required' }, { status: 400 });
    }

    if (!turnstileToken) {
        return json({ error: 'Turnstile verification failed' }, { status: 400 });
    }

    // Verify Turnstile token
    const clientIp = getClientIp(request);
    const isTurnstileValid = await verifyTurnstileToken(turnstileToken, clientIp, env);
    if (!isTurnstileValid) {
        return json({ error: 'Turnstile verification failed' }, { status: 400 });
    }

    try {
        // Authenticate the user
        const authenticated = await authenticateUser(email, password, env);
        if (!authenticated) {
            return json({ error: 'Invalid email or password' }, { status: 401 });
        }
        const user = await applyBootstrapAdmin(authenticated, env);

        const sessionId = await createUserSession(user, env);

        return json({
            message: 'Login successful',
            email: user.email,
            name: user.name,
            userId: user.email,
            isAdmin: accessOf(user, env).isAdmin,
            sessionId,
        });
    } catch (error) {
        console.error('Error logging in:', error);
        return json({ error: 'Failed to login' }, { status: 500 });
    }
});

// Set or update password for current user
router.post('/set-password', async (request: Request, env) => {
    console.log('POST /auth/set-password called');
    
    // Verify session
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!sessionId) {
        return json({ error: 'Session ID is required' }, { status: 400 });
    }

    const session = await GetSession(sessionId, env);
    if (!session) {
        return json({ error: 'Session not found or expired' }, { status: 403 });
    }

    // Get password from request
    const body = await request.json() as { password: string };
    const { password } = body;

    // Validate password strength
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
        return json({ error: passwordValidation.message }, { status: 400 });
    }

    try {
        const success = await setUserPassword(session.userId, password, env);
        if (!success) {
            return json({ error: 'Failed to set password' }, { status: 500 });
        }

        return json({ message: 'Password set successfully' });
    } catch (error) {
        console.error('Error setting password:', error);
        return json({ error: 'Failed to set password' }, { status: 500 });
    }
});

// Request password reset - sends reset email
router.post('/forgot-password', async (request: Request, env) => {
    console.log('POST /auth/forgot-password called');
    const body = await request.json() as { email: string; turnstileToken: string };
    const { email, turnstileToken } = body;

    if (!email) {
        return json({ error: 'Email is required' }, { status: 400 });
    }
    
    if (!turnstileToken) {
        return json({ error: 'Turnstile verification failed' }, { status: 400 });
    }

    // Verify Turnstile token
    const clientIp = getClientIp(request);
    const isTurnstileValid = await verifyTurnstileToken(turnstileToken, clientIp, env);
    if (!isTurnstileValid) {
        return json({ error: 'Turnstile verification failed' }, { status: 400 });
    }

    try {
        // Check if user exists
        const user = await getUser(email, env);
        if (!user) {
            // Don't reveal whether a user exists or not for security reasons
            return json({ message: 'If an account with that email exists, a password reset link has been sent.' });
        }

        // Generate and store reset token (1 hour expiration)
        const resetToken = await createAndStoreToken(user.id, 'reset-token', 3600000, env);
        const resetUrl = buildTokenUrl(resetToken, 'reset-password', env);

        // Send reset email
        const sent = await sendEmailIfConfigured(user.email, 'Password Reset Request', `
            <h1>Password Reset Request</h1>
            <p>Hello ${user.name},</p>
            <p>You've requested to reset your password. Click the link below to create a new password:</p>
            <p><a href="${resetUrl}">Reset Password</a></p>
            <p>This link will expire in 1 hour.</p>
            <p>If you didn't request a password reset, please ignore this email.</p>
        `, env);

        if (!sent) {
            return json({
                message: 'If an account with that email exists, a password reset link has been sent.',
                ...debugToken(resetToken, env)
            });
        }

        return json({ message: 'If an account with that email exists, a password reset link has been sent.' });
    } catch (error) {
        console.error('Error requesting password reset:', error);
        return json({ error: 'Failed to process request' }, { status: 500 });
    }
});

// Reset password using token
router.post('/reset-password', async (request: Request, env) => {
    console.log('POST /auth/reset-password called');
    const body = await request.json() as { token: string; password: string; turnstileToken: string };
    const { token, password, turnstileToken } = body;

    if (!token || !password) {
        return json({ error: 'Token and password are required' }, { status: 400 });
    }

    if (!turnstileToken) {
        return json({ error: 'Turnstile verification failed' }, { status: 400 });
    }

    // Verify Turnstile token
    const clientIp = getClientIp(request);
    const isTurnstileValid = await verifyTurnstileToken(turnstileToken, clientIp, env);
    if (!isTurnstileValid) {
        return json({ error: 'Turnstile verification failed' }, { status: 400 });
    }

    // Validate password strength
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
        return json({ error: passwordValidation.message }, { status: 400 });
    }

    try {
        const tokenData = await validateToken(token, 'reset-token', env);
        if (!tokenData) {
            return json({ error: 'Invalid or expired token' }, { status: 400 });
        }

        // Set new password
        const success = await setUserPassword(tokenData.userId, password, env);
        if (!success) {
            return json({ error: 'Failed to update password' }, { status: 500 });
        }

        // Delete the used token
        await env.STORE.delete(`reset-token/${token}`);

        return json({ message: 'Password has been reset successfully' });
    } catch (error) {
        console.error('Error resetting password:', error);
        return json({ error: 'Failed to reset password' }, { status: 500 });
    }
});

// Validate reset token
router.post('/validate-reset-token', async (request: Request, env) => {
    console.log('POST /auth/validate-reset-token called');
    const body = await request.json() as { token: string };
    const { token } = body;

    if (!token) {
        return json({ error: 'Token is required' }, { status: 400 });
    }

    try {
        const tokenData = await validateToken(token, 'reset-token', env);
        if (!tokenData) {
            return json({ error: 'Invalid or expired token' }, { status: 400 });
        }

        return json({ valid: true });
    } catch (error) {
        console.error('Error validating token:', error);
        return json({ error: 'Failed to validate token' }, { status: 500 });
    }
});

router.post('/loginGoogleToken', async (request: Request, env) => {
    console.log('POST /auth/loginGoogleToken called');
    const body = await request.json() as { token: string };
    const { token } = body;

    if (!token) {
        return json({ error: 'Token is required' }, { status: 400 });
    }

    let payload: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
    try {
        payload = await verifyGoogleIdToken(token, env.GOOGLE_CLIENT_ID);
    } catch (error) {
        console.error('Error verifying token:', error);
        return json({ error: 'Invalid token' }, { status: 401 });
    }

    // Past this point a failure is ours (e.g. the store), not a bad token: answer
    // 500 so the client retries rather than reporting an invalid login.
    try {
        const { email, name } = payload;

        // Create or get the user. Google has verified the address, so mark it
        // verified (dropping any unproven password) and promote bootstrap admins.
        const existingOrNew = await getOrCreateUser({ name, email }, env);
        const user = await applyBootstrapAdmin(await markVerifiedByGoogle(existingOrNew, env), env);

        const sessionId = await createUserSession(user, env);

        return json({
            message: 'Token verified',
            email,
            name,
            userId: user.email,
            isAdmin: accessOf(user, env).isAdmin,
            sessionId,
        });
    } catch (error) {
        console.error('Error signing in with Google:', error);
        return json({ error: 'Failed to sign in' }, { status: 500 });
    }
});

router.get('/session', async (request: Request, env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');

    // Try real session first
    if (sessionId) {
        const session = await GetSession(sessionId, env);
        if (session) {
            return json({ message: 'Session retrieved', session });
        }
    }

    // Fall back to dev bypass if no real session
    if (env.DEV_BYPASS_AUTH === 'true') {
        const devUser = getDevUserForRequest(request);
        return json({ message: 'Session retrieved', session: { userId: devUser.id, email: devUser.email, name: devUser.name } });
    }

    if (!sessionId) {
        return json({ error: 'Session ID is required' }, { status: 400 });
    }
    return json({ error: 'Session not found or expired' }, { status: 404 });
});

// Get current user from session
router.get('/me', async (request: Request, env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');

    // Try real session first
    if (sessionId) {
        const session = await GetSession(sessionId, env);
        if (session) {
            const user = await getUser(session.userId, env);
            if (user) {
                // Without the password hash; with the access fields (services/access.ts)
                return json({ user: { ...publicUser(user), ...accessView(user, env) } });
            }
        }
    }

    // Fall back to dev bypass if no real session/user
    if (env.DEV_BYPASS_AUTH === 'true') {
        const devUser = getDevUserForRequest(request);
        return json({ user: { ...devUser, ...accessView(devUser, env) } });
    }

    if (!sessionId) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }
    return json({ error: 'Unauthorized' }, { status: 401 });
});

router.post('/logout', async (request: Request, env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!sessionId) {
        return json({ error: 'Session ID is required' }, { status: 400 });
    }

    await DeleteSession(sessionId, env);
    return json({ message: 'Logged out successfully' });
});
