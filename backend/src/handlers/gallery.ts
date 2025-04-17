import { AutoRouter, IRequest } from 'itty-router';
import { getMedia, uploadMedia, deleteMedia, isUserAdmin } from '../services/mediaService';
import { json } from 'itty-router-extras';
import { Env } from '../utils/sessionManager';
import { MediaItem, GalleryComment } from '../types';
import { withAdminCheck, withAuthCheck } from '../authWrappers';
import { canAccessGroup, getUserNotificationSettings, getUser } from '../services/userService';
import { getGalleryComments, addGalleryComment, deleteGalleryComment } from '../services/galleryCommentService';
import { notifyAboutReply, notifyGroupAboutNewContent } from '../services/notificationService';
import { sendReplyNotification } from '../utils/email';

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
        
        // If this is a group media item, notify group members
        if (groupId && isPublic && result.success && result.mediaItem) {
            try {
                // Get user name from session
                const userKey = `user/${request.user}`;
                const userObject = await env.R2.get(userKey);
                let userName = 'Admin';
                
                if (userObject) {
                    const userData = await userObject.json() as { name?: string };
                    if (userData.name) {
                        userName = userData.name;
                    }
                }
                
                // Send notifications to group members
                await notifyGroupAboutNewContent(
                    groupId,
                    request.user,
                    userName,
                    'gallery',
                    result.mediaItem.id.replace('gallery/', ''), // Get the ID without the prefix
                    result.mediaItem.fileName || 'New gallery item',
                    'A new image has been uploaded to the gallery.', // Generic description for media
                    env
                );
            } catch (notifyError) {
                console.error('Error sending group notifications:', notifyError);
                // Continue even if notification fails
            }
        }
        
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
        
        // Create a new headers object that's compatible with Cloudflare Workers
        const headers = new Headers();
        
        // Manually copy the headers instead of using writeHttpMetadata
        if (mediaContent.httpMetadata?.contentType) {
            headers.set('Content-Type', mediaContent.httpMetadata.contentType);
        }
        headers.set('etag', mediaContent.httpEtag);
        
        // Convert the R2 body to a type that Response can accept
        // This avoids the ReadableStream compatibility issues
        return new Response(mediaContent.body as unknown as BodyInit, {
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
        
        // Create a new headers object that's compatible with Cloudflare Workers
        const headers = new Headers();
        
        // Manually copy the headers instead of using writeHttpMetadata
        if (thumbnailObject.httpMetadata?.contentType) {
            headers.set('Content-Type', thumbnailObject.httpMetadata.contentType);
        }
        headers.set('etag', thumbnailObject.httpEtag);
        
        // Convert the R2 body to a type that Response can accept
        return new Response(thumbnailObject.body as unknown as BodyInit, {
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

// Get comments for a media item
router.get('/:id/comments', async (request: ExtendedRequest, env: Env) => {
    try {
        const { id } = request.params;
        console.log(`GET /gallery/${id}/comments called`);
        
        const comments = await getGalleryComments(id, env);
        return json(comments);
    } catch (error) {
        console.error('Error fetching gallery comments:', error);
        return json({ error: 'Error fetching comments' }, { status: 500 });
    }
});

// Add a comment to a media item (authenticated users only)
router.post('/:id/comments', withAuthCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        const { id } = request.params;
        console.log(`POST /gallery/${id}/comments called`);
        
        if (!request.user) {
            return json({ error: 'User not authenticated' }, { status: 401 });
        }
        
        const { content, parentId } = await request.json() as { 
            content: string;
            parentId?: string; 
        };
        
        if (!content) {
            return json({ error: 'Comment content is required' }, { status: 400 });
        }
        
        // Get user name from session
        const userKey = `user/${request.user}`;
        const userObject = await env.R2.get(userKey);
        let userName = 'User';
        
        if (userObject) {
            const userData = await userObject.json() as { name?: string };
            if (userData.name) {
                userName = userData.name;
            }
        }
        
        // Determine the nesting level based on parentId
        let level = 0;
        
        if (parentId) {
            // If this is a reply, find the parent comment to get its level
            const comments = await getGalleryComments(id, env);
            const findParentWithLevel = (comments: any[], parentId: string): number => {
                for (const comment of comments) {
                    if (comment.id === parentId) {
                        return comment.level;
                    }
                    
                    if (comment.replies && comment.replies.length > 0) {
                        const found = findParentWithLevel(comment.replies, parentId);
                        if (found >= 0) {
                            return found;
                        }
                    }
                }
                return -1;
            };
            
            const parentLevel = findParentWithLevel(comments, parentId);
            if (parentLevel >= 0) {
                // Maximum nesting level is 2 (allowing 3 levels total: 0, 1, 2)
                level = Math.min(parentLevel + 1, 2);
            } else {
                return json({ error: 'Parent comment not found' }, { status: 404 });
            }
        }
        
        const result = await addGalleryComment(id, content, request.user, userName, parentId || null, level, env);
        
        if (result.success) {
            // If this is a reply to a comment, send a notification to the parent comment author
            if (parentId && result.comment) {
                // Get the parent comment to find its author
                const comments = await getGalleryComments(id, env);
                const findParentComment = (comments: any[], parentId: string): GalleryComment | null => {
                    for (const comment of comments) {
                        if (comment.id === parentId) {
                            return comment;
                        }
                        
                        if (comment.replies && comment.replies.length > 0) {
                            const found = findParentComment(comment.replies, parentId);
                            if (found) {
                                return found;
                            }
                        }
                    }
                    return null;
                };
                
                const parentComment = findParentComment(comments, parentId);
                
                if (parentComment && parentComment.authorId) {
                    try {
                        // Don't notify if user is replying to their own comment
                        if (parentComment.authorId !== request.user) {
                            await notifyAboutReply(
                                parentComment.authorId,
                                userName,
                                'gallery',
                                result.comment.id,
                                id, // Media ID
                                content.substring(0, 200), // Truncate long comments
                                env
                            );
                            
                            // Get user email settings and email address
                            const parentAuthorSettings = await getUserNotificationSettings(parentComment.authorId, env);
                            const parentAuthor = await getUser(parentComment.authorId, env);
                            
                            // Send email notification if the user has notifications enabled
                            if (parentAuthorSettings.notifyOnReplies && parentAuthor?.email && env.SESKey && env.SESSecret) {
                                const contentUrl = `https://dancingcats.org/gallery?comment=${result.comment.id}#${result.comment.id}`;
                                await sendReplyNotification(
                                    parentAuthor.email,
                                    userName,
                                    'gallery',
                                    content.substring(0, 150), // Truncate for email
                                    contentUrl,
                                    env.SESKey,
                                    env.SESSecret
                                );
                                console.log(`Email notification sent to ${parentAuthor.email}`);
                            }
                        }
                    } catch (notifyError) {
                        console.error('Error sending notification:', notifyError);
                        // Continue even if notification fails
                    }
                }
            } else if (result.comment) {
                // This is a top-level comment, get media item to find the uploader
                try {
                    // Get the media item metadata to find the uploader
                    const mediaKey = `gallery/${id}`;
                    const mediaObject = await env.R2.head(mediaKey);
                    
                    if (mediaObject && mediaObject.customMetadata && mediaObject.customMetadata.userId) {
                        const mediaUploaderId = mediaObject.customMetadata.userId;
                        
                        // Don't notify if user is commenting on their own upload
                        if (mediaUploaderId !== request.user) {
                            await notifyAboutReply(
                                mediaUploaderId,
                                userName,
                                'gallery',
                                result.comment.id,
                                id, // Media ID
                                content.substring(0, 200), // Truncate long comments
                                env
                            );
                            
                            // Get user email settings and email address
                            const uploaderSettings = await getUserNotificationSettings(mediaUploaderId, env);
                            const uploader = await getUser(mediaUploaderId, env);
                            
                            // Send email notification if the user has notifications enabled
                            if (uploaderSettings.notifyOnReplies && uploader?.email && env.SESKey && env.SESSecret) {
                                const contentUrl = `https://dancingcats.org/gallery?comment=${result.comment.id}#${result.comment.id}`;
                                await sendReplyNotification(
                                    uploader.email,
                                    userName,
                                    'gallery',
                                    content.substring(0, 150), // Truncate for email
                                    contentUrl,
                                    env.SESKey,
                                    env.SESSecret
                                );
                                console.log(`Email notification sent to ${uploader.email}`);
                            }
                        }
                    }
                } catch (notifyError) {
                    console.error('Error sending notification:', notifyError);
                    // Continue even if notification fails
                }
            }
            
            return json(result, { status: 201 });
        } else {
            return json(result, { status: 400 });
        }
    } catch (error) {
        console.error('Error adding gallery comment:', error);
        return json({ error: 'Error adding comment' }, { status: 500 });
    }
});

// Delete a comment (admin only)
router.delete('/:mediaId/comments/:commentId', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        const { mediaId, commentId } = request.params;
        console.log(`DELETE /gallery/${mediaId}/comments/${commentId} called`);
        
        const result = await deleteGalleryComment(mediaId, commentId, env);
        
        if (result.success) {
            return json(result);
        } else {
            return json(result, { status: 404 });
        }
    } catch (error) {
        console.error('Error deleting gallery comment:', error);
        return json({ error: 'Error deleting comment' }, { status: 500 });
    }
});

// Fallback route for unmatched requests
router.all('*', () => {
    console.error('No matching route found');
    return new Response('Route not found', { status: 404 });
});
