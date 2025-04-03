import { AutoRouter, IRequest } from 'itty-router';
import { getMedia, uploadMedia, isUserAdmin } from '../services/mediaService';
import { json } from 'itty-router-extras';
import { Env } from '../utils/sessionManager';
import { MediaItem } from '../types';
import { withAdminCheck } from '../authWrappers';

// Extend the Request interface to include user and params properties
interface ExtendedRequest extends IRequest {
    user?: string;
    params: Record<string, string>;
}

export const router = AutoRouter({ base: '/gallery' });

// Handler to get media content
router.get('/', async (request: ExtendedRequest, env: Env) => {
    try {
        console.log('GET /gallery called');
        const media = await getMedia(env);
        return new Response(JSON.stringify(media), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('Error fetching media:', error);
        return new Response('Error fetching media', { status: 500 });
    }
});

// Handler to upload media content
router.post('/upload', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        console.log('POST /gallery/upload called');
        const formData = await request.formData();
        const mediaFile = formData.get('file');
        const thumbnailFile = formData.get('thumbnail');

        if (!(mediaFile instanceof File)) {
            console.error('Invalid media file uploaded');
            return json({ error: 'Invalid media file' }, { status: 400 });
        }

        if (!(thumbnailFile instanceof File)) {
            console.error('Invalid thumbnail file uploaded');
            return json({ error: 'Invalid thumbnail file' }, { status: 400 });
        }

        if (!request.user) {
            console.error('User is not authenticated');
            return json({ error: 'User is not authenticated' }, { status: 401 });
        }
        
        const result = await uploadMedia(mediaFile, thumbnailFile, request.user, env);
        return json(result);
    } catch (error) {
        console.error('Error uploading media:', error);
        return json({ 
            error: 'Error uploading media',
            message: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 });
    }
});

// Handler to get a specific media item
router.get('/:id', async (request: ExtendedRequest, env: Env) => {
    try {
        const id = request.params.id;
        const mediaKey = `gallery/${id}`;
        
        const mediaObject = await env.R2.get(mediaKey);
        if (!mediaObject) {
            return json({ error: 'Media not found' }, { status: 404 });
        }
        
        const headers = new Headers();
        mediaObject.writeHttpMetadata(headers);
        headers.set('etag', mediaObject.httpEtag);
        
        return new Response(mediaObject.body, {
            headers
        });
    } catch (error) {
        console.error('Error fetching media item:', error);
        return json({ error: 'Error fetching media item' }, { status: 500 });
    }
});

// Handler to get a thumbnail for a specific media item
router.get('/:id/thumbnail', async (request: ExtendedRequest, env: Env) => {
    try {
        const id = request.params.id;
        const thumbnailKey = `gallery/thumbnails/${id}`;
        
        const thumbnailObject = await env.R2.get(thumbnailKey);
        if (!thumbnailObject) {
            return json({ error: 'Thumbnail not found' }, { status: 404 });
        }
        
        const headers = new Headers();
        thumbnailObject.writeHttpMetadata(headers);
        headers.set('etag', thumbnailObject.httpEtag);
        
        return new Response(thumbnailObject.body, {
            headers
        });
    } catch (error) {
        console.error('Error fetching thumbnail:', error);
        return json({ error: 'Error fetching thumbnail' }, { status: 500 });
    }
});

// Fallback route for unmatched requests
router.all('*', () => {
    console.error('No matching route found');
    return new Response('Route not found', { status: 404 });
});
