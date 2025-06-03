import { Router } from 'itty-router';
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

export const router = Router();

// Get all media items
router.get('/', withAuth, async (request: Request, env: Env) => {
    const user = (request as any).user as User;
    const media = await getMedia(env, user.id);
    return new Response(JSON.stringify(media), {
        headers: { 'Content-Type': 'application/json' }
    });
});

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

// Get a specific media item
router.get('/:id', async (request: Request, env: Env) => {
    try {
        const { id } = (request as any).params;
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
});

// Get a thumbnail for a specific media item
router.get('/:id/thumbnail', async (request: Request, env: Env) => {
    try {
        const { id } = (request as any).params;
        const media = await getMedia(env);
        const item = media.find(m => m.id === id);
        if (!item || !item.thumbnailUrl) {
            return new Response('Thumbnail not found', { status: 404 });
        }
        return new Response(JSON.stringify({ url: item.thumbnailUrl }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response('Error fetching thumbnail', { status: 500 });
    }
});

// Get a medium-sized version of a specific media item
router.get('/:id/medium', async (request: Request, env: Env) => {
    try {
        const { id } = (request as any).params;
        const media = await getMedia(env);
        const item = media.find(m => m.id === id);
        if (!item || !item.mediumUrl) {
            return new Response('Medium version not found', { status: 404 });
        }
        return new Response(JSON.stringify({ url: item.mediumUrl }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response('Error fetching medium version', { status: 500 });
    }
});

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

// Fallback route for unmatched requests
router.all('*', () => {
    console.error('No matching route found');
    return new Response('Route not found', { status: 404 });
});
