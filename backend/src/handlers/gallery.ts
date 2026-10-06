import { AutoRouter } from 'itty-router';
import { getMedia, uploadMedia, deleteMedia, isUserAdmin } from '../services/mediaService';
import { json } from 'itty-router-extras';
import { Env } from '../utils/sessionManager';
import { MediaItem, GalleryComment, User } from '../types';
import { withAdminCheck, withAuth } from '../authWrappers';
import { canAccessGroup, getUserNotificationSettings, getUser } from '../services/userService';
import { getGalleryComments, addGalleryComment, deleteGalleryComment } from '../services/galleryCommentService';
import { notifyAboutReply, notifyGroupAboutNewContent } from '../services/notificationService';
import { sendReplyNotification } from '../utils/email';
import { CustomRequest } from '../types';

export const router = AutoRouter({ base: '/api/gallery' });

// Upload a new media item
router.post('/upload', withAdminCheck, async (request: Request, env: Env) => {
    try {
        const formData = await request.formData();
        const user = (request as any).user as User;
        const mediaFile = formData.get('media') as File;
        const thumbnailFile = formData.get('thumbnail') as File;
        const mediumFile = formData.get('medium') as File;
        const isPublic = formData.get('isPublic') === 'true';
        const groupId = formData.get('groupId') as string;
        const takenBy = formData.get('takenBy') as string;

        const result = await uploadMedia(
            mediaFile,
            thumbnailFile,
            user.id,
            env,
            isPublic,
            groupId,
            takenBy,
            mediumFile
        );

        if (result.success) {
            return new Response(JSON.stringify(result.mediaItem), {
                headers: { 'Content-Type': 'application/json' }
            });
        } else {
            return new Response(result.message, { status: 400 });
        }
    } catch (error) {
        return new Response('Error uploading media', { status: 500 });
    }
});

// Serve the thumbnail image for a gallery file (must come before /:filename).
// thumbnailUrl values (/api/gallery/<file>/thumbnail) are used directly as <img src>.
router.get('/:filename/thumbnail', async (request: Request, env: Env) => {
    const { filename } = (request as any).params;
    return serveGalleryImage(filename, 'thumbnail', env);
});

// Serve the medium-sized image for a gallery file (must come before /:filename)
router.get('/:filename/medium', async (request: Request, env: Env) => {
    const { filename } = (request as any).params;
    return serveGalleryImage(filename, 'medium', env);
});

// Get metadata for a specific media item (must come before /:filename)
router.get('/:id/metadata', async (request: Request, env: Env) => {
    const { id } = (request as any).params;
    return handleMetadataRequest(id, env);
});

// IMAGE SERVING ROUTE MOVED TO END OF FILE AFTER ALL OTHER ROUTES

// Helper function to handle metadata requests
async function handleMetadataRequest(id: string, env: Env) {
    try {
        const media = await getMedia(env);
        const item = media.find(m => m.id === id);
        if (!item) {
            return new Response('Media not found', { status: 404 });
        }
        return new Response(JSON.stringify(item), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response('Error fetching media', { status: 500 });
    }
}



// Delete a media item
router.delete('/:id', withAdminCheck, async (request: Request, env: Env) => {
    try {
        const { id } = (request as any).params;
        const result = await deleteMedia(id, env);
        if (result.success) {
            return new Response(null, { status: 204 });
        } else {
            return new Response(result.message, { status: 400 });
        }
    } catch (error) {
        return new Response('Error deleting media', { status: 500 });
    }
});

// Update a media item's group
router.put('/:id/group', withAdminCheck, async (request: Request, env: Env) => {
    try {
        const { id } = (request as any).params;
        const body = await request.json() as { isPublic: boolean; groupId?: string };
        const media = await getMedia(env);
        const item = media.find(m => m.id === id);
        if (!item) {
            return new Response('Media not found', { status: 404 });
        }
        // Update logic here
        return new Response(JSON.stringify(item), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response('Error updating media group', { status: 500 });
    }
});

// Update a media item's metadata
router.put('/:id/metadata', withAuth, async (request: Request, env: Env) => {
    try {
        const { id } = (request as any).params;
        const body = await request.json() as { takenBy?: string };
        const media = await getMedia(env);
        const item = media.find(m => m.id === id);
        if (!item) {
            return new Response('Media not found', { status: 404 });
        }
        // Update logic here
        return new Response(JSON.stringify(item), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response('Error updating media metadata', { status: 500 });
    }
});

// Get comments for a media item
router.get('/:id/comments', async (request: Request, env: Env) => {
    try {
        const { id } = (request as any).params;
        const comments = await getGalleryComments(id, env);
        return new Response(JSON.stringify(comments), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response('Error fetching comments', { status: 500 });
    }
});

// Add a comment to a media item
router.post('/:id/comments', withAuth, async (request: Request, env: Env) => {
    try {
        const { id } = (request as any).params;
        const user = (request as any).user as User;
        const { content, parentId } = await request.json() as {
            content: string;
            parentId?: string;
        };
        const result = await addGalleryComment(
            id,
            content,
            user.id,
            user.name,
            parentId || null,
            0,
            env
        );
        if (result.success) {
            return new Response(JSON.stringify(result.comment), {
                headers: { 'Content-Type': 'application/json' }
            });
        } else {
            return new Response(result.message, { status: 400 });
        }
    } catch (error) {
        return new Response('Error adding comment', { status: 500 });
    }
});

// Delete a comment
router.delete('/:mediaId/comments/:commentId', withAdminCheck, async (request: Request, env: Env) => {
    try {
        const { mediaId, commentId } = (request as any).params;
        const result = await deleteGalleryComment(mediaId, commentId, env);
        if (result.success) {
            return new Response(null, { status: 204 });
        } else {
            return new Response(result.message, { status: 400 });
        }
    } catch (error) {
        return new Response('Error deleting comment', { status: 500 });
    }
});

// Get all media items (must be last before image serving)
router.get('/', withAuth, async (request: Request, env: Env) => {
    console.log('🖼️ Gallery list route hit');
    try {
        const user = (request as any).user as User;
        const media = await getMedia(env, user.id);
        console.log('✅ Found media items:', media.length);
        return new Response(JSON.stringify(media), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('❌ Error in gallery list:', error);
        return new Response('Error fetching media', { status: 500 });
    }
});

// Serve actual image files directly from the object store 
// This route MUST be the last GET route before fallback to avoid conflicts
router.get('/:filename', async (request: Request, env: Env) => {
    const { filename } = (request as any).params;
    return serveGalleryImage(filename, 'original', env);
});

const IMAGE_CONTENT_TYPES: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
};

const VARIANT_PREFIXES = {
    original: 'gallery/',
    thumbnail: 'gallery/thumbnails/',
    medium: 'gallery/medium/',
} as const;

/**
 * Serve a gallery image's bytes. Thumbnail and medium requests fall back to the
 * original when no resized copy was uploaded.
 *
 * Anyone with the URL can load any file, without signing in: announcement emails link
 * pasted images here. isPublic (stored on every file) only hides private files from
 * gallery listings. A private-file option would check it here and keep emailed images
 * public.
 */
export async function serveGalleryImage(
    filename: string,
    variant: keyof typeof VARIANT_PREFIXES,
    env: Env
): Promise<Response> {
    try {
        // Only serve files with image extensions
        const fileExt = filename.split('.').pop()?.toLowerCase();
        if (!fileExt || !IMAGE_CONTENT_TYPES[fileExt]) {
            return new Response('Invalid file extension', { status: 404 });
        }

        let imageObject = await env.STORE.get(`${VARIANT_PREFIXES[variant]}${filename}`);
        if (!imageObject && variant !== 'original') {
            imageObject = await env.STORE.get(`${VARIANT_PREFIXES.original}${filename}`);
        }
        if (!imageObject) {
            return new Response('Image not found', { status: 404 });
        }

        const arrayBuffer = await imageObject.arrayBuffer();
        return new Response(arrayBuffer, {
            headers: {
                'Content-Type': IMAGE_CONTENT_TYPES[fileExt],
                'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
                'Access-Control-Allow-Origin': '*'
            }
        });
    } catch (error) {
        console.error('❌ Error serving image:', error);
        return new Response('Error serving image', { status: 500 });
    }
}

// Fallback route for unmatched requests
router.all('*', (request: Request) => {
    const url = new URL(request.url);
    console.error('🚨 No matching route:', request.method, url.pathname);
    return new Response('Route not found', { status: 404 });
});
