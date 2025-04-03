import { json } from 'itty-router-extras';
import { router as authRouter } from './handlers/auth';
import { router as blogRouter } from './handlers/blog';
import { router as galleryRouter } from './handlers/gallery';
import { router as adminRouter } from './handlers/admin';
import { AutoRouter, cors } from 'itty-router';
import { GetSession, Env } from './utils/sessionManager';
import { initializeFirstAdmin } from './services/userService';

declare global {
    interface Request {
        user?: string;
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
}

// Initialize the first admin user
const initializeAdmin = async (env: Env) => {
    await initializeFirstAdmin(env);
};

router
    .get('/', async (request: Request, env: Env) => {
        // Initialize admin on first request
        try {
            await initializeAdmin(env);
        } catch (error) {
            console.error('Error initializing admin:', error);
        }
        return new Response('API is running');
    })
    .all('/auth/*', authRouter.fetch) // Handle all auth routes
    .all('/blog/*', blogRouter.fetch) // Handle all blog routes
    .all('/gallery/*', withValidSession) // Middleware to check session for gallery routes
    .all('/gallery/*', galleryRouter.fetch) // Handle all gallery routes
    .all('/admin/*', withValidSession) // Middleware to check session for admin routes
    .all('/admin/*', adminRouter.fetch) // Handle all admin routes
    .get('/foo', () => corsify(json({ message: 'Hello from foo!' }))) // Example route
    

export default router
