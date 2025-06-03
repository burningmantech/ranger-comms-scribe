import { json } from 'itty-router-extras';
import { router as authRouter } from './handlers/auth';
import { router as blogRouter } from './handlers/blog';
import { router as galleryRouter } from './handlers/gallery';
import { router as adminRouter } from './handlers/admin';
import { router as pageRouter } from './handlers/page';
import { router as userRouter } from './handlers/user';
import contentSubmissionRouter from './handlers/contentSubmission';
import { router as councilMemberRouter } from './handlers/councilMembers';
import reminderRouter from './handlers/reminders';
import commsCadreRouter from './handlers/commsCadre';
import { AutoRouter, cors } from 'itty-router';
import { GetSession, Env } from './utils/sessionManager';
import { initializeFirstAdmin } from './services/userService';
import { setExistingContentPublic } from './migrations/setExistingContentPublic';
import { ensureUserGroups } from './migrations/ensureUserGroups';
import { initCache } from './services/cacheService';
import { cachePageSlugs } from './services/pageService';
import { sendReminders } from './handlers/reminders';
import { initializeContentTables } from './migrations/createContentTables';
import { identifyCouncilManagers } from './services/councilManagerService';
import { createAuthTables } from './migrations/createAuthTables';

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
    // origin: 'https://scrivenly.com',
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
    console.log('initializeApp called');
    console.log('ENV KEYS in initializeApp:', Object.keys(env));
    
    if (!env.D1) {
        throw new Error('Database binding D1 is missing');
    }
    
    try {
        // Initialize cache database
        await initCache(env);
        
        // Create auth tables
        await createAuthTables(env);
        
        // Initialize the first admin user
        await initializeFirstAdmin(env);
        
        // Run migrations
        await setExistingContentPublic(env);
        await ensureUserGroups(env);
        await initializeContentTables(env);

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
    .get('/', async (request: Request, env: Env) => {
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
    .all('/auth/*', authRouter.fetch) // Handle all auth routes
    .all('/blog/*', blogRouter.fetch) // Handle all blog routes
    .all('/gallery/*', withOptionalSession) // Allow gallery to identify users with a session
    .all('/gallery/*', galleryRouter.fetch) // Handle all gallery routes
    .all('/page/*', withOptionalSession) // Allow page to identify users with a session
    .all('/page/*', pageRouter.fetch) // Handle all page routes
    .all('/admin/*', withValidSession) // Middleware to check session for admin routes
    .all('/admin/*', adminRouter.fetch) // Handle all admin routes
    .all('/user/*', withValidSession) // Middleware to check session for user routes
    .all('/user/*', userRouter.fetch) // Handle all user routes
    .all('/content/*', withValidSession) // Middleware to check session for content routes
    .all('/content/*', contentSubmissionRouter.fetch) // Handle all content submission routes
    .all('/council/*', withValidSession) // Middleware to check session for council routes
    .all('/council/*', councilMemberRouter.fetch) // Handle all council member routes
    .all('/reminders/*', withValidSession) // Middleware to check session for reminder routes
    .all('/reminders/*', reminderRouter.fetch) // Handle all reminder routes
    .all('/comms-cadre/*', withValidSession) // Middleware to check session for Comms Cadre routes
    .all('/comms-cadre/*', commsCadreRouter.fetch) // Handle all Comms Cadre routes

export default router
