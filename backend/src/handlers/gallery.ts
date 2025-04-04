import { AutoRouter, IRequest } from 'itty-router';
import { getMedia, uploadMedia, deleteMedia, isUserAdmin } from '../services/mediaService';
import { json } from 'itty-router-extras';
import { Env } from '../utils/sessionManager';
import { MediaItem } from '../types';
import { withAdminCheck } from '../authWrappers';
import { canAccessGroup } from '../services/userService';

// Extend the Request interface to include user and params properties
interface ExtendedRequest extends IRequest {
    user?: string;
    userid?: string;
    params: Record<string, string>;
}

export const router = AutoRouter({ base: '/gallery' });

// Handler to get media content
router.get('/', async (request: ExtendedRequest, env: Env) => {
    try {
        console.log('GET /gallery called');
        const media = await getMedia(env, request.userId);
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
        
        // Get group information from form data
        const isPublicValue = formData.get('isPublic');
        const isPublic = isPublicValue === 'true' || isPublicValue !== 'false'; // Default to true
        const groupId = formData.get('groupId') as string | null;
        
        const result = await uploadMedia(mediaFile, thumbnailFile, request.user, env, isPublic, groupId || undefined);
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
        const userId = request.userId;
        
        // First check if the media exists
        const mediaObject = await env.R2.head(mediaKey);
        if (!mediaObject) {
            return json({ error: 'Media not found' }, { status: 404 });
        }
        
        // Check access permissions
        const metadata = mediaObject.customMetadata;
        const isPublic = metadata?.isPublic !== 'false'; // Default to true for backward compatibility
        const groupId = metadata?.groupId;
        
        // If not public, check permissions
        if (!isPublic) {
            // If no user is authenticated, deny access
            if (!userId) {
                return json({ error: 'Access denied' }, { status: 403 });
            }
            
            // If media belongs to a group, check if user has access to that group
            if (groupId) {
                const hasAccess = await canAccessGroup(userId, groupId, env);
                if (!hasAccess) {
                    return json({ error: 'Access denied' }, { status: 403 });
                }
            }
        }
        
        // If we get here, the user has access to the media
        const mediaContent = await env.R2.get(mediaKey);
        if (!mediaContent) {
            return json({ error: 'Media content not found' }, { status: 404 });
        }
        
        const headers = new Headers();
        mediaContent.writeHttpMetadata(headers);
        headers.set('etag', mediaContent.httpEtag);
        
        return new Response(mediaContent.body, {
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
        const mediaKey = `gallery/${id}`;
        const thumbnailKey = `gallery/thumbnails/${id}`;
        const userId = request.userId;
        
        // First check if the media exists
        const mediaObject = await env.R2.head(mediaKey);
        if (!mediaObject) {
            return json({ error: 'Media not found' }, { status: 404 });
        }
        
        // Check access permissions
        const metadata = mediaObject.customMetadata;
        const isPublic = metadata?.isPublic !== 'false'; // Default to true for backward compatibility
        const groupId = metadata?.groupId;
        
        // If not public, check permissions
        if (!isPublic) {
            // If no user is authenticated, deny access
            if (!userId) {
                return json({ error: 'Access denied' }, { status: 403 });
            }
            
            // If media belongs to a group, check if user has access to that group
            if (groupId) {
                const hasAccess = await canAccessGroup(userId, groupId, env);
                if (!hasAccess) {
                    return json({ error: 'Access denied' }, { status: 403 });
                }
            }
        }
        
        // If we get here, the user has access to the thumbnail
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

// Handler to delete a media item
router.delete('/:id', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        console.log('DELETE /gallery/:id called');
        const id = request.params.id;
        const mediaKey = `gallery/${id}`;
        
        const result = await deleteMedia(mediaKey, env);
        
        if (result.success) {
            return json(result);
        } else {
            return json(result, { status: 404 });
        }
    } catch (error) {
        console.error('Error deleting media:', error);
        return json({ 
            error: 'Error deleting media',
            message: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 });
    }
});

// Update a media item's group
router.put('/:id/group', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        const id = request.params.id;
        const mediaKey = `gallery/${id}`;
        
        // Get the media item
        const mediaObject = await env.R2.head(mediaKey);
        if (!mediaObject) {
            return json({ error: 'Media not found' }, { status: 404 });
        }
        
        // Get the request body
        const body = await request.json() as { isPublic: boolean; groupId?: string };
        const { isPublic, groupId } = body;
        
        // Update the custom metadata
        const updatedMetadata = { ...mediaObject.customMetadata };
        updatedMetadata.isPublic = isPublic ? 'true' : 'false';
        if (groupId) {
            updatedMetadata.groupId = groupId;
        } else {
            delete updatedMetadata.groupId;
        }
        
        // Get the existing content
        const existingContent = await env.R2.get(mediaKey);
        if (!existingContent) {
            return json({ error: 'Media content not found' }, { status: 404 });
        }
        
        // Save the updated media item with the same content but updated metadata
        await env.R2.put(mediaKey, existingContent.body, {
            httpMetadata: mediaObject.httpMetadata,
            customMetadata: updatedMetadata
        });
        
        // Create a MediaItem object to return
        const fileName = mediaKey.split('/').pop() || '';
        const fileType = mediaObject.httpMetadata?.contentType || '';
        
        // Check if a thumbnail exists
        const thumbnailKey = mediaKey.replace('gallery/', 'gallery/thumbnails/');
        let thumbnailUrl = '';
        try {
            const thumbnailExists = await env.R2.head(thumbnailKey);
            if (thumbnailExists) {
                thumbnailUrl = `${env.PUBLIC_URL}/gallery/${fileName}/thumbnail`;
            }
        } catch (error) {
            // Thumbnail doesn't exist
        }
        
        const mediaItem: MediaItem = {
            id: mediaKey,
            fileName: fileName,
            fileType: fileType,
            url: `${env.PUBLIC_URL}/gallery/${fileName}`,
            thumbnailUrl: thumbnailUrl,
            uploadedBy: updatedMetadata.userId || 'unknown',
            uploadedAt: updatedMetadata.createdAt || new Date().toISOString(),
            size: mediaObject.size,
            isPublic: isPublic,
            groupId: groupId
        };
        
        return json({ 
            success: true, 
            message: 'Media group updated successfully',
            mediaItem
        });
    } catch (error) {
        console.error('Error updating media group:', error);
        return json({ 
            error: 'Error updating media group',
            message: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 });
    }
});

// Fallback route for unmatched requests
router.all('*', () => {
    console.error('No matching route found');
    return new Response('Route not found', { status: 404 });
});
