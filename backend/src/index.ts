import { json } from 'itty-router-extras';
import { router as authRouter } from './handlers/auth';
import { router as blogRouter } from './handlers/blog';
import { router as galleryRouter } from './handlers/gallery';
import { router as adminRouter } from './handlers/admin';
import { router as pageRouter } from './handlers/page';
import { router as userRouter } from './handlers/user';
import { router as contentSubmissionRouter } from './handlers/contentSubmission';
import { router as councilMemberRouter } from './handlers/councilMembers';
import reminderRouter from './handlers/reminders';
import { router as commsCadreRouter } from './handlers/commsCadre';
import { router as trackedChangesRouter } from './handlers/trackedChanges';
import { router as websocketRouter } from './handlers/websocket';
import { SubmissionWebSocketServer } from './services/websocketService';
import { AutoRouter, cors } from 'itty-router';
import { GetSession, Env } from './utils/sessionManager';
import { initializeFirstAdmin, getUser } from './services/userService';
import { setExistingContentPublic } from './migrations/setExistingContentPublic';
import { ensureUserGroups } from './migrations/ensureUserGroups';
import { initCache } from './services/cacheService';
import { cachePageSlugs } from './services/pageService';
import { sendReminders } from './handlers/reminders';
import { identifyCouncilManagers } from './services/councilManagerService';

declare global {
    interface Request {
        user?: string;
        userId?: string;
    }
    
    // Add GLOBAL_ENV to the global scope
    interface Window {
        GLOBAL_ENV?: Env;
    }
    
    // Make TypeScript recognize GLOBAL_ENV on globalThis
    var GLOBAL_ENV: Env | undefined;
}

export const { preflight, corsify } = cors({
    origin: (origin: string) => {
        const allowedOrigins = [
            'https://scrivenly.com',
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:3001'
        ];
        
        if (allowedOrigins.includes(origin)) {
            return origin;
        }
        
        // Return undefined to reject the origin
        return undefined;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowHeaders: [
        'Content-Type',
        'Authorization', 
        'X-Requested-With',
        'Accept',
        'Origin',
        'Cache-Control',
        'Pragma'
    ],
    credentials: true,
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

    const userData = session.data as { email: string; name: string };
    const user = await getUser(userData.email, env);
    if (!user) {
        return json({ error: 'User not found' }, { status: 403 });
    }

    (request as any).user = user;
    return undefined;
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
    console.log('initializeApp called');
    console.log('ENV KEYS in initializeApp:', Object.keys(env));
    
    if (!env.D1) {
        throw new Error('Database binding D1 is missing');
    }
    
    try {
        // Initialize cache database
        await initCache(env);
        
        // Initialize the first admin user
        await initializeFirstAdmin(env);
        
        // Run migrations
        await setExistingContentPublic(env);
        await ensureUserGroups(env);

        // Identify Council managers from org chart
        await identifyCouncilManagers(env);

        // Cache page slugs
        await cachePageSlugs(env);
        
        // Verify tables were created
        const tables = await env.D1.exec("SELECT name FROM sqlite_master WHERE type='table'");
        console.log('Final tables after initialization:', JSON.stringify(tables));
    } catch (e) {
        console.error('Error in initializeApp:', e);
        throw e; // Re-throw the error to be handled by the caller
    }
};

// Add scheduled reminder sending
export async function scheduled(env: Env) {
  await sendReminders(env);
}

router
    .get('/api', async (request: Request, env: Env) => {
        // Initialize app on first request
        try {
            console.log('Initializing application from root endpoint...');
            await initializeApp(env);
            console.log('Application initialized successfully from root endpoint');
        } catch (error) {
            console.error('Error initializing application:', error);
        }
        return new Response('API is running');
    })
    .all('/api/auth/*', authRouter.fetch) // Handle all auth routes
    .all('/api/blog/*', blogRouter.fetch) // Handle all blog routes
    .all('/api/gallery/*', withOptionalSession) // Allow gallery to identify users with a session
    .all('/api/gallery/*', galleryRouter.fetch) // Handle all gallery routes
    .all('/api/page/*', withOptionalSession) // Allow page to identify users with a session
    .all('/api/page/*', pageRouter.fetch) // Handle all page routes
    .all('/api/admin/*', withValidSession) // Middleware to check session for admin routes
    .all('/api/admin/*', adminRouter.fetch) // Handle all admin routes
    .all('/api/user/*', withValidSession) // Middleware to check session for user routes
    .all('/api/user/*', userRouter.fetch) // Handle all user routes
    .all('/api/content/*', withValidSession) // Middleware to check session for content routes
    .all('/api/content/*', contentSubmissionRouter.fetch) // Handle all content submission routes
    .all('/api/council/*', withValidSession) // Middleware to check session for council routes
    .all('/api/council/*', councilMemberRouter.fetch) // Handle all council member routes
    .all('/api/reminders/*', withValidSession) // Middleware to check session for reminder routes
    .all('/api/reminders/*', reminderRouter.fetch) // Handle all reminder routes
    .all('/api/comms-cadre/*', withValidSession) // Middleware to check session for Comms Cadre routes
    .all('/api/comms-cadre/*', commsCadreRouter.fetch) // Handle all Comms Cadre routes
    .all('/api/tracked-changes/*', withValidSession) // Middleware to check session for tracked changes routes
    .all('/api/tracked-changes/*', trackedChangesRouter.fetch) // Handle all tracked changes routes
    .all('/api/ws/*', websocketRouter.fetch) // Handle all WebSocket routes (auth is handled in the router)
    .all('*', (request: Request) => {
        console.log('Unmatched request in main router:', request.url);
        return new Response('Not Found', { status: 404 });
    });

export default router

// Export the Durable Object class
export { SubmissionWebSocketServer }
