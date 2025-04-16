import { Env } from '../utils/sessionManager';
import { GalleryComment } from '../types';
import { isUserBlocked } from '../services/blogService';

// Get comments for a media item
export const getGalleryComments = async (mediaId: string, env: Env): Promise<GalleryComment[]> => {
    try {
        // List all objects with the gallery/comments/mediaId/ prefix
        const objects = await env.R2.list({ prefix: `gallery/comments/${mediaId}/` });
        
        // Create a list of promises to get each comment's content
        const commentPromises = objects.objects.map(async (object: { key: string }) => {
            const commentObject = await env.R2.get(object.key);
            if (!commentObject) return null;
            
            const comment = await commentObject.json() as GalleryComment;
            return comment;
        });
        
        // Wait for all promises to resolve and filter out null values
        const comments = (await Promise.all(commentPromises)).filter((comment): comment is GalleryComment => comment !== null);
        
        // Create a map to store comments by ID for easy lookup
        const commentsMap = new Map<string, GalleryComment>();
        
        // Initialize comments map with all comments
        comments.forEach(comment => {
            commentsMap.set(comment.id, {...comment, replies: []});
        });
        
        // Process comments to build the reply tree
        const rootComments: GalleryComment[] = [];
        
        comments.forEach(comment => {
            if (comment.parentId) {
                // This is a reply, add it to its parent's replies array
                const parent = commentsMap.get(comment.parentId);
                if (parent && parent.replies) {
                    parent.replies.push(commentsMap.get(comment.id) || comment);
                }
            } else {
                // This is a root comment, add it to the result array
                rootComments.push(commentsMap.get(comment.id) || comment);
            }
        });
        
        // Sort root comments by creation date (newest first)
        return rootComments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch (error) {
        console.error('Error fetching gallery comments from R2:', error);
        return [];
    }
};

// Add a comment to a gallery item
export const addGalleryComment = async (
    mediaId: string,
    content: string,
    userId: string,
    userName: string,
    parentId: string | null,
    level: number,
    env: Env
): Promise<{ success: boolean; message: string; comment?: GalleryComment }> => {
    try {
        // Check if the user is blocked
        const isBlocked = await isUserBlocked(userId, env);
        if (isBlocked) {
            return { 
                success: false, 
                message: 'You are not allowed to comment on gallery items' 
            };
        }
        
        // Generate a unique ID for the comment
        const timestamp = Date.now();
        const randomSuffix = Math.random().toString(36).substring(2, 9);
        const commentId = `comment_${timestamp}_${randomSuffix}`;
        const isoTimestamp = new Date().toISOString();
        
        // Create the comment object
        const newComment: GalleryComment = {
            id: commentId,
            mediaId: mediaId,
            content: content,
            author: userName,
            authorId: userId,
            createdAt: isoTimestamp,
            isBlocked: false,
            level,
            parentId: parentId || undefined,
            replies: []
        };
        
        // Store the comment in R2
        const commentKey = `gallery/comments/${mediaId}/${commentId}`;
        await env.R2.put(commentKey, JSON.stringify(newComment));
        
        return { 
            success: true, 
            message: 'Comment added successfully',
            comment: newComment 
        };
    } catch (error) {
        console.error('Error adding comment to gallery item:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred' 
        };
    }
};

// Delete a gallery comment
export const deleteGalleryComment = async (
    mediaId: string,
    commentId: string,
    env: Env
): Promise<{ success: boolean; message: string }> => {
    try {
        // Check if the comment exists
        const commentKey = `gallery/comments/${mediaId}/${commentId}`;
        const commentObject = await env.R2.get(commentKey);
        
        if (!commentObject) {
            return { 
                success: false, 
                message: 'Comment not found' 
            };
        }
        
        // Get the comment to check if it has replies
        const comment = await commentObject.json() as GalleryComment;
        
        // Delete the comment
        await env.R2.delete(commentKey);
        
        // If this is a parent comment, we need to delete all replies too
        if (!comment.parentId) {
            // List all comments for this media item
            const objects = await env.R2.list({ prefix: `gallery/comments/${mediaId}/` });
            
            // Delete all replies to this comment
            const deletionPromises = objects.objects
                .map(async (object: { key: string }) => {
                    const replyObject = await env.R2.get(object.key);
                    if (!replyObject) return;
                    
                    const reply = await replyObject.json() as GalleryComment;
                    if (reply.parentId === commentId) {
                        await env.R2.delete(object.key);
                    }
                });
            
            await Promise.all(deletionPromises);
        }
        
        return { 
            success: true, 
            message: 'Comment deleted successfully' 
        };
    } catch (error) {
        console.error('Error deleting gallery comment:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred' 
        };
    }
};