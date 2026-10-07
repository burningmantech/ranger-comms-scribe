import { json } from 'itty-router-extras';
import { router as authRouter } from './handlers/auth';
import { getDevUserForRequest } from './utils/devUsers';
import { router as blogRouter } from './handlers/blog';
import { router as galleryRouter } from './handlers/gallery';
import { router as adminRouter } from './handlers/admin';
import { router as pageRouter } from './handlers/page';
import { router as userRouter } from './handlers/user';
import { router as contentSubmissionRouter } from './handlers/contentSubmission';
import { router as councilMemberRouter } from './handlers/councilMembers';
import { router as commsCadreRouter } from './handlers/commsCadre';
import { router as trackedChangesRouter } from './handlers/trackedChanges';
import { timelineRouter } from './handlers/timeline';
import { router as templatesRouter } from './handlers/templates';
import { router as notificationsRouter } from './handlers/notifications';
import { router as commsCalendarRouter } from './handlers/commsCalendar';
import { router as annualDatesRouter } from './handlers/annualDates';
import { router as websocketRouter } from './handlers/websocket';
import { router as newsletterRouter } from './handlers/newsletter';
import { router as mailingListsRouter } from './handlers/mailingLists';
import { router as publicNewsRouter } from './handlers/publicNews';
import { router as feedbackRouter } from './handlers/feedback';
import { AutoRouter, cors } from 'itty-router';
import { GetSession, Env } from './utils/sessionManager';
import { getUser, initializeFirstAdmin } from './services/userService';
import { initCache } from './services/cacheService';
import { cachePageSlugs } from './services/pageService';
import { migratePeopleAccess } from './migrations/peopleAccess';
import { migrateNotificationsByEmail } from './migrations/notificationsByEmail';

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

// Allowed CORS origins. Set once at boot from CORS_ORIGINS (see config/env.ts).
// In AWS the SPA and API share one origin, so this only matters for local dev.
let allowedOrigins: string[] = ['http://localhost:3000'];

export function configureCors(origins: string[] | undefined): void {
    if (origins && origins.length > 0) {
        allowedOrigins = [...origins];
    }
}

export const { preflight, corsify } = cors({
    // Return undefined to reject the origin
    origin: (origin: string) => (allowedOrigins.includes(origin) ? origin : undefined),
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

export const router = AutoRouter({
    before: [preflight],
    finally: [corsify]
});

/** Body of GET /api/config. Anything but an explicit 'yjs' is the legacy mode. */
export function clientConfig(env: Env): { collabMode: 'yjs' | 'legacy' } {
    return { collabMode: env.COLLAB_MODE === 'yjs' ? 'yjs' : 'legacy' };
}

const withValidSession = async (request: Request, env: Env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');

    // Try real session first
    if (sessionId) {
        const session = await GetSession(sessionId, env);
        if (session) {
            const userData = session.data as { email: string; name: string };
            const user = await getUser(userData.email, env);
            if (user) {
                (request as any).user = user;
                return undefined;
            }
        }
    }

    // Fall back to dev bypass if no real session/user
    if (env.DEV_BYPASS_AUTH === 'true') {
        (request as any).user = getDevUserForRequest(request); // utils/devUsers.ts
        return undefined;
    }

    if (!sessionId) {
        return json({ error: 'Session ID is required' }, { status: 400 });
    }
    return json({ error: 'Session not found or expired' }, { status: 403 });
}

const withOptionalSession = async (request: Request, env: Env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (sessionId) {
        const session = await GetSession(sessionId, env);
        if (session) {
            const user = await getUser(session.userId, env);
            if (user) {
                (request as any).user = user;
            }
        }
    }
}

/**
 * One-time startup work. The Node server calls this once at boot (it used to run
 * on every GET /api in the Worker).
 */
export const initializeApp = async (env: Env): Promise<void> => {
    await initCache(env);

    // Once: move everyone's access onto their record (docs/plans/2026-10-06-people-and-roles.md)
    await migratePeopleAccess(env);

    // Once: in-app notifications stored under a user id move to the person's email
    await migrateNotificationsByEmail(env);

    // Promote any BOOTSTRAP_ADMIN_EMAILS users that already exist
    await initializeFirstAdmin(env);

    // Cache page slugs
    await cachePageSlugs(env);
};

router
    .get('/healthz', () => json({ ok: true })) // ALB target-group health check (outside /api)
    .get('/api', () => new Response('API is running'))
    // Public client configuration (no session needed): which real-time editing mode to use
    .get('/api/config', (_request: Request, env: Env) => json(clientConfig(env)))
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
    .all('/api/comms-cadre/*', withValidSession) // Middleware to check session for Comms Cadre routes
    .all('/api/comms-cadre/*', commsCadreRouter.fetch) // Handle all Comms Cadre routes
    .all('/api/tracked-changes/*', withValidSession) // Middleware to check session for tracked changes routes
    .all('/api/tracked-changes/*', trackedChangesRouter.fetch) // Handle all tracked changes routes
    .all('/api/timeline/*', withValidSession) // Middleware to check session for timeline routes
    .all('/api/timeline/*', timelineRouter.fetch) // Handle all timeline routes
    .all('/api/templates/*', withValidSession) // Middleware to check session for templates routes
    .all('/api/templates/*', templatesRouter.fetch) // Handle all template routes
    .all('/api/notifications/*', withValidSession) // Middleware to check session for notification routes
    .all('/api/notifications/*', notificationsRouter.fetch) // Handle all notification routes
    .all('/api/mailing-lists/*', withValidSession) // Mailing lists (Requests → Settings)
    .all('/api/mailing-lists/*', mailingListsRouter.fetch)
    .all('/api/newsletter/*', withValidSession) // Middleware to check session for newsletter routes
    .all('/api/newsletter/*', newsletterRouter.fetch) // Newsletter editions (Comms Cadre)
    .all('/api/public/*', publicNewsRouter.fetch) // Public pages: sent editions and published documents (no session)
    .all('/api/comms-calendar/*', withValidSession) // Middleware to check session for Comms Calendar routes
    .all('/api/comms-calendar/*', commsCalendarRouter.fetch) // Handle all Comms Calendar routes
    .all('/api/annual-dates/*', withValidSession) // Annual dates (fixed or from Labor Day) that requests link to
    .all('/api/annual-dates/*', annualDatesRouter.fetch)
    .all('/api/feedback/*', withValidSession) // The feedback tab (Admin → Feedback is under /api/admin)
    .all('/api/feedback/*', feedbackRouter.fetch)
    .all('/api/ws/*', websocketRouter.fetch) // Room HTTP routes; WebSocket upgrades are handled in httpServer.ts
    .all('*', (request: Request) => {
        console.log('Unmatched request in main router:', request.url);
        return new Response('Not Found', { status: 404 });
    });
