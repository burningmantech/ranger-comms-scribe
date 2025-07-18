import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { zxcvbn } from '@zxcvbn-ts/core';
import { CreateSession, DeleteSession, GetSession } from '../utils/sessionManager';
import { getUser, getOrCreateUser, approveUser, authenticateUser, setUserPassword, markUserAsVerified } from '../services/userService';
import { User } from '../types';
import { sendEmail } from '../utils/email';
import { verifyTurnstileToken } from '../utils/turnstile';

export const router = AutoRouter({ base : '/api/auth' });

async function verify(token: string) {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    if (!response.ok) {
        throw new Error('Invalid token');
    }
    const payload = await response.json() as { email: string; name: string; sub: string };
    return payload
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
    const clientIp = request.headers.get('CF-Connecting-IP');
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
        // Check if user with this email already exists
        const existingUser = await getUser(email, env);
        if (existingUser && existingUser.passwordHash) {
            return json({ error: 'User with this email already exists' }, { status: 409 });
        }

        // Create the user with password
        const user = await getOrCreateUser({ name, email, password }, env);

        // Generate verification token
        const verificationToken = crypto.randomUUID();
        const expiresAt = Date.now() + 86400000; // 24 hours expiration
        
        // Store the token in R2 with user ID
        await env.R2.put(`verification-token/${verificationToken}`, JSON.stringify({
            userId: user.id,
            expiresAt
        }), {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { userId: user.id }
        });

        // Create verification URL
        const frontendUrl = env.FRONTEND_URL || env.PUBLIC_URL || 'https://scrivenly.com';
        const verificationUrl = `${frontendUrl}/verify-email?token=${verificationToken}`;

        // Email content
        const subject = 'Verify Your Email';
        const message = `
            <h1>Welcome to our platform!</h1>
            <p>Hello ${user.name},</p>
            <p>Thank you for registering. Please click the link below to verify your email address:</p>
            <p><a href="${verificationUrl}">Verify Email</a></p>
            <p>This link will expire in 24 hours.</p>
        `;

        // Send verification email if email service is configured
        if (env.SESKey && env.SESSecret) {
            try {
                await sendEmail(
                    user.email,
                    subject,
                    message,
                    env.SESKey,
                    env.SESSecret
                );
                console.log('Verification email sent to:', user.email);
            } catch (emailError) {
                console.error('Error sending verification email:', emailError);
                // Continue with registration even if email fails
            }
        } else {
            console.log('Email service not configured, verification link:', verificationUrl);
        }

        // Create a session for the user
        const sessionId = await CreateSession(user.id, { 
          email, 
          name,
          isAdmin: user.isAdmin,
          userType: user.userType,
          approved: user.approved,
          verified: user.verified
        }, env);

        return json({
            message: 'User registered successfully. Please check your email to verify your account.',
            email,
            name,
            userId: user.id,
            approved: user.approved,
            isAdmin: user.isAdmin,
            verified: false,
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
        // Retrieve token from R2
        const tokenObj = await env.R2.get(`verification-token/${token}`);
        if (!tokenObj) {
            return json({ error: 'Invalid or expired verification token' }, { status: 400 });
        }

        const tokenData = await tokenObj.json() as { userId: string; expiresAt: number };
        
        // Check if token has expired
        if (tokenData.expiresAt < Date.now()) {
            // Delete expired token
            await env.R2.delete(`verification-token/${token}`);
            return json({ error: 'Verification link has expired' }, { status: 400 });
        }

        // Mark user as verified
        const user = await markUserAsVerified(tokenData.userId, env);
        if (!user) {
            return json({ error: 'Failed to verify user' }, { status: 500 });
        }

        // Delete the used token
        await env.R2.delete(`verification-token/${token}`);

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
        const verificationToken = crypto.randomUUID();
        const expiresAt = Date.now() + 86400000; // 24 hours expiration
        
        // Store the token in R2 with user ID
        await env.R2.put(`verification-token/${verificationToken}`, JSON.stringify({
            userId: user.id,
            expiresAt
        }), {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { userId: user.id }
        });

        // Create verification URL
        const frontendUrl = env.FRONTEND_URL || env.PUBLIC_URL || 'https://scrivenly.com';
        const verificationUrl = `${frontendUrl}/verify-email?token=${verificationToken}`;

        // Email content
        const subject = 'Verify Your Email';
        const message = `
            <h1>Email Verification</h1>
            <p>Hello ${user.name},</p>
            <p>Please click the link below to verify your email address:</p>
            <p><a href="${verificationUrl}">Verify Email</a></p>
            <p>This link will expire in 24 hours.</p>
        `;

        // Check if email service is configured
        if (!env.SESKey || !env.SESSecret) {
            return json({ 
                message: 'Verification email would have been sent.',
                debug: 'Email service not configured - token: ' + verificationToken
            });
        }

        // Send the email
        await sendEmail(
            user.email,
            subject,
            message,
            env.SESKey,
            env.SESSecret
        );

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
    const clientIp = request.headers.get('CF-Connecting-IP');
    const isTurnstileValid = await verifyTurnstileToken(turnstileToken, clientIp, env);
    if (!isTurnstileValid) {
        return json({ error: 'Turnstile verification failed' }, { status: 400 });
    }

    try {
        // Authenticate the user
        const user = await authenticateUser(email, password, env);
        if (!user) {
            return json({ error: 'Invalid email or password' }, { status: 401 });
        }

        // Create a session for the user
        const sessionId = await CreateSession(user.id, { 
          email, 
          name,
          isAdmin: user.isAdmin,
          userType: user.userType,
          approved: user.approved,
          verified: user.verified
        }, env);

        return json({
            message: 'Login successful',
            email: user.email,
            name: user.name,
            userId: user.id,
            approved: user.approved,
            isAdmin: user.isAdmin,
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
    const clientIp = request.headers.get('CF-Connecting-IP');
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

        // Generate a token for password reset (a simple UUID with expiration)
        const resetToken = crypto.randomUUID();
        const expiresAt = Date.now() + 3600000; // 1 hour expiration
        
        // Store the token in R2 with user ID
        await env.R2.put(`reset-token/${resetToken}`, JSON.stringify({
            userId: user.id,
            expiresAt
        }), {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { userId: user.id }
        });

        // Create reset URL (frontend should handle this route)
        const frontendUrl = env.FRONTEND_URL || env.PUBLIC_URL || 'https://scrivenly.com';
        const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

        // Email content
        const subject = 'Password Reset Request';
        const message = `
            <h1>Password Reset Request</h1>
            <p>Hello ${user.name},</p>
            <p>You've requested to reset your password. Click the link below to create a new password:</p>
            <p><a href="${resetUrl}">Reset Password</a></p>
            <p>This link will expire in 1 hour.</p>
            <p>If you didn't request a password reset, please ignore this email.</p>
        `;

        // Check if email service is configured
        if (!env.SESKey || !env.SESSecret) {
            console.error('Email service not configured');
            return json({ 
                message: 'If an account with that email exists, a password reset link has been sent.',
                debug: 'Email service not configured - token: ' + resetToken
            });
        }

        // Send the email
        await sendEmail(
            user.email,
            subject,
            message,
            env.SESKey,
            env.SESSecret
        );

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
    const clientIp = request.headers.get('CF-Connecting-IP');
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
        // Retrieve token from R2
        const tokenObj = await env.R2.get(`reset-token/${token}`);
        if (!tokenObj) {
            return json({ error: 'Invalid or expired token' }, { status: 400 });
        }

        const tokenData = await tokenObj.json() as { userId: string; expiresAt: number };
        
        // Check if token has expired
        if (tokenData.expiresAt < Date.now()) {
            // Delete expired token
            await env.R2.delete(`reset-token/${token}`);
            return json({ error: 'Token has expired' }, { status: 400 });
        }

        // Set new password
        const success = await setUserPassword(tokenData.userId, password, env);
        if (!success) {
            return json({ error: 'Failed to update password' }, { status: 500 });
        }

        // Delete the used token
        await env.R2.delete(`reset-token/${token}`);

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
        // Retrieve token from R2
        const tokenObj = await env.R2.get(`reset-token/${token}`);
        if (!tokenObj) {
            return json({ error: 'Invalid or expired token' }, { status: 400 });
        }

        const tokenData = await tokenObj.json() as { userId: string; expiresAt: number };
        
        // Check if token has expired
        if (tokenData.expiresAt < Date.now()) {
            // Delete expired token
            await env.R2.delete(`reset-token/${token}`);
            return json({ error: 'Token has expired' }, { status: 400 });
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

    try {
        const payload = await verify(token);
        const { email, name, sub } = payload; // Extract email, name, and user ID (sub)

        // Create or get the user
        const user = await getOrCreateUser({ name, email }, env);

        // Create a session for the user
        const sessionId = await CreateSession(user.id, { 
          email, 
          name,
          isAdmin: user.isAdmin,
          userType: user.userType,
          approved: user.approved,
          verified: user.verified
        }, env);

        return json({
            message: 'Token verified',
            email,
            name,
            userId: user.id,
            approved: user.approved,
            isAdmin: user.isAdmin,
            sessionId, // Return the session ID to the client
        });
    } catch (error) {
        console.error('Error verifying token:', error);
        return json({ error: 'Invalid token' }, { status: 401 });
    }
});

router.get('/session', async (request: Request, env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!sessionId) {
        return json({ error: 'Session ID is required' }, { status: 400 });
    }

    const session = await GetSession(sessionId, env);
    if (!session) {
        return json({ error: 'Session not found or expired' }, { status: 404 });
    }

    return json({ message: 'Session retrieved', session });
});

router.post('/logout', async (request: Request, env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!sessionId) {
        return json({ error: 'Session ID is required' }, { status: 400 });
    }

    await DeleteSession(sessionId, env);
    return json({ message: 'Logged out successfully' });
});

// This route is now handled by the admin handler
router.post('/approve', async (request: Request, env) => {
  const body = await request.json() as { userId: string };
  const { userId } = body;

  if (!userId) {
    return json({ error: 'User ID is required' }, { status: 400 });
  }

  const approvedUser = await approveUser(userId, env);
  if (!approvedUser) {
    return json({ error: 'User not found' }, { status: 404 });
  }
  
  return json({ message: 'User approved', user: approvedUser });
});
