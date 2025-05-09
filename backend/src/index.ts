import { json } from 'itty-router-extras';
import { router as authRouter } from './handlers/auth';
import { router as blogRouter } from './handlers/blog';
import { router as galleryRouter } from './handlers/gallery';
import { router as adminRouter } from './handlers/admin';
import { router as pageRouter } from './handlers/page';
import { router as userRouter } from './handlers/user';
import { AutoRouter, cors } from 'itty-router';
import { GetSession, Env } from './utils/sessionManager';
import { initializeFirstAdmin } from './services/userService';
import { setExistingContentPublic } from './migrations/setExistingContentPublic';
import { ensureUserGroups } from './migrations/ensureUserGroups';
import { initCache } from './services/cacheService';
import { cachePageSlugs } from './services/pageService';

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
    // Initialize cache database
    await initCache(env);
    
    // Initialize the first admin user
    await initializeFirstAdmin(env);
    
    // Run migrations
    await setExistingContentPublic(env);
    await ensureUserGroups(env);

    // Cache page slugs
    await cachePageSlugs(env);
};

// Immediately initialize the application when the script loads
(async () => {
    try {
        // Get env from wrangler if possible (when running locally)
        if (typeof globalThis.GLOBAL_ENV !== 'undefined') {
            console.log('Initializing application on startup...');
            await initializeApp(globalThis.GLOBAL_ENV);
            console.log('Application initialized successfully on startup');
        }
    } catch (error) {
        console.error('Error during automatic initialization:', error);
    }
})();

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
    .get('/debug-d1', async (request: Request, env: Env) => {
        // Special debug endpoint to test D1 directly
        try {
            console.log('D1 DEBUG: Starting D1 debug test');
            
            if (!env.D1) {
                console.error('D1 DEBUG: D1 binding is undefined!');
                return new Response('D1 binding is missing', { status: 500 });
            }
            
            console.log('D1 DEBUG: D1 binding exists');
            
            try {
                // Check if D1 is accessible
                const tables = await env.D1.exec("SELECT name FROM sqlite_master WHERE type='table'");
                console.log('D1 DEBUG: Current tables:', JSON.stringify(tables));
            } catch (error) {
                console.error('D1 DEBUG: Error querying existing tables:', error);
            }
            
            try {
                // Try to create the table directly with fixed SQL syntax
                console.log('D1 DEBUG: Attempting to create object_cache table...');
                await env.D1.exec(
                    "CREATE TABLE IF NOT EXISTS object_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, last_updated INTEGER NOT NULL, ttl INTEGER NOT NULL)"
                );
                console.log('D1 DEBUG: Table creation command completed');
                
                // Verify table was created
                const tableCheck = await env.D1.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='object_cache'");
                console.log('D1 DEBUG: Table check result:', JSON.stringify(tableCheck));
                
            } catch (error) {
                console.error('D1 DEBUG: Error creating table:', error);
                return new Response(`D1 error: ${error instanceof Error ? error.message : String(error)}`, 
                    { status: 500 });
            }
            
            return new Response('D1 debug completed, check logs', { status: 200 });
        } catch (error) {
            console.error('D1 DEBUG: Unexpected error:', error);
            return new Response(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, 
                { status: 500 });
        }
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
    

export default router
