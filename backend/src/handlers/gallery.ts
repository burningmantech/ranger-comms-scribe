import { AutoRouter } from 'itty-router';
import { getMedia, uploadMedia } from '../services/mediaService';
import { env } from 'cloudflare:workers';

export const router = AutoRouter({ base : '/gallery' });

// Handler to get media content
router.get('/', async () => {
    try {
        console.log('GET /gallery called');
        const media = await getMedia();
        return new Response(JSON.stringify(media), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('Error fetching media:', error);
        return new Response('Error fetching media', { status: 500 });
    }
});

// Handler to upload media content
router.post('/upload', async (request, env) => {
    try {
        console.log('POST /gallery/upload called');
        const formData = await request.formData();
        const mediaFile = formData.get('file');

        if (!(mediaFile instanceof File)) {
            console.error('Invalid file uploaded');
            return new Response('Invalid file uploaded', { status: 400 });
        }

        if (!request.user) {
            console.error('User is not authenticated');
            return new Response('User is not authenticated', { status: 401 });
        }
        
        const result = await uploadMedia(mediaFile, request.user, env);
        return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('Error uploading media:', error);
        return new Response('Error uploading media', { status: 500 });
    }
});

// Fallback route for unmatched requests
router.all('*', () => {
    console.error('No matching route found');
    return new Response('Route not found', { status: 404 });
});