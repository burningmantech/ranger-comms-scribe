import { json } from 'itty-router-extras';
import { router as authRouter } from './handlers/auth';
import { router as blogRouter } from './handlers/blog';
import { router as galleryRouter } from './handlers/gallery';
import { AutoRouter, cors } from 'itty-router';

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

router
    .get('/', () => new Response('API is running'))
    .all('/auth/*', authRouter.fetch) // Handle all auth routes
    .all('/blog/*', blogRouter.fetch) // Handle all blog routes
    .all('/gallery/*', galleryRouter.fetch) // Handle all gallery routes
    .get('/foo', () => corsify(json({ message: 'Hello from foo!' }))) // Example route
    

export default router