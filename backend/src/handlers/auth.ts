import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { CreateSession, DeleteSession, GetSession } from '../utils/sessionManager';
import { getUser, createUser, approveUser } from '../services/userService';
import { User } from '../types';

export const router = AutoRouter({ base : '/auth' });

async function verify(token: string) {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    if (!response.ok) {
        throw new Error('Invalid token');
    }
    const payload = await response.json() as { email: string; name: string; sub: string };
    return payload
}

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
        const user = await createUser({ name, email }, env);

        // Create a session for the user
        const sessionId = await CreateSession(user.id, { email, name }, env);

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
