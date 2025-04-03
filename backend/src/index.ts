import { json } from 'itty-router-extras';
import { router as authRouter } from './handlers/auth';
import { router as blogRouter } from './handlers/blog';
import { router as galleryRouter } from './handlers/gallery';
import { router as adminRouter } from './handlers/admin';
import { AutoRouter, cors } from 'itty-router';
import { GetSession, Env } from './utils/sessionManager';
import { initializeFirstAdmin } from './services/userService';
import { setExistingContentPublic } from './migrations/setExistingContentPublic';
import { ensureUserGroups } from './migrations/ensureUserGroups';

declare global {
    interface Request {
        user?: string;
        userId?: string;
    }
}

export const { preflight, corsify } = cors({
    // origin: 'https://dancingcats.org',
    origin: '*',
    allowMethods: '*',
    maxAge: 84600,
});

const router = AutoRouter({
    before: [preflight],
    finally: [corsify]
});

const withValidSession = async (request: Request, env: Env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!sessionId) {
        return json({ error: 'Session ID is required' }, { status: 400 });
    }

    const session = await GetSession(sessionId, env);
    if (!session) {
        return json({ error: 'Session not found or expired' }, { status: 403 });
    }

    const user = session.data.email;
    request.user = user
    request.userId = session.id
}

const withOptionalSession = async (request: Request, env: Env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (sessionId) {
        const session = await GetSession(sessionId, env);
        if (session) {
            const user = session.data.email;
            request.user = user
            request.userId = session.userId
        }
    }
}

// Initialize the application
const initializeApp = async (env: Env) => {
    // Initialize the first admin user
    await initializeFirstAdmin(env);
    
    // Run migrations
    await setExistingContentPublic(env);
    await ensureUserGroups(env);
};

router
    .get('/', async (request: Request, env: Env) => {
        // Initialize app on first request
        try {
            await initializeApp(env);
        } catch (error) {
            console.error('Error initializing application:', error);
        }
        return new Response('API is running');
    })
    .all('/auth/*', authRouter.fetch) // Handle all auth routes
    .all('/blog/*', blogRouter.fetch) // Handle all blog routes
    .all('/gallery/*', withOptionalSession) // Allow gallery to identify users with a session
    .all('/gallery/*', galleryRouter.fetch) // Handle all gallery routes
    .all('/admin/*', withValidSession) // Middleware to check session for admin routes
    .all('/admin/*', adminRouter.fetch) // Handle all admin routes
    

export default router
