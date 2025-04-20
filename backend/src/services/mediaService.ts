import { GetSession, Env } from '../utils/sessionManager';
import { MediaItem, UserType } from '../types';
import { getUser, canAccessGroup } from '../services/userService';

// Function to get group names for media items
const getGroupName = async (groupId: string, env: Env): Promise<string> => {
    try {
        const groupKey = `group/${groupId}`;
        const groupObject = await env.R2.get(groupKey);
        if (groupObject) {
            const groupData = await groupObject.json() as { name: string };
            return groupData.name;
        }
    } catch (error) {
        console.error(`Error getting group name for ${groupId}:`, error);
    }
    return 'Unknown';
};

// Function to properly convert isPublic from string to boolean
const parseIsPublic = (value: any): boolean => {
    if (typeof value === 'boolean') {
        return value;
    }
    // Handle string values 'true'/'false'
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true';
    }
    // Default to false for security (changed from true)
    return false;
};

// Get all media from the gallery folder in R2
export const getMedia = async (env: Env, userId?: string): Promise<MediaItem[]> => {
    try {
        // List all objects with the gallery/ prefix
        const objects = await env.R2.list({ prefix: 'gallery/' });
        
        // Create a list of promises to get each object's metadata
        const mediaPromises = objects.objects.map(async (object) => {
            // Skip thumbnail files and comment files when listing
            if (object.key.includes('thumbnails') || object.key.includes('comments')) {
                return null;
            }
            
            // Get the object's metadata
            const metadata = object.customMetadata;
            
            // Check if a thumbnail exists for this file
            const thumbnailKey = object.key.replace('gallery/', 'gallery/thumbnails/');
            let thumbnailUrl = '';
            
            try {
                const thumbnailExists = await env.R2.head(thumbnailKey);
                if (thumbnailExists) {
                    thumbnailUrl = `${env.PUBLIC_URL}/gallery/${object.key.split('/').pop()}/thumbnail`;
                }
            } catch (error) {
                thumbnailUrl = '';
            }
            
            // Get the file name and extension
            const fileName = object.key.split('/').pop() || '';

            // Use our helper function to consistently parse isPublic
            const isPublic = parseIsPublic(metadata?.isPublic);
            
            const mediaItem: MediaItem = {
                id: object.key,
                fileName,
                fileType: object.httpMetadata?.contentType || 'application/octet-stream',
                url: `${env.PUBLIC_URL}/gallery/${fileName}`,
                thumbnailUrl,
                uploadedBy: metadata?.userId || 'unknown',
                uploadedAt: metadata?.createdAt || new Date().toISOString(),
                size: object.size,
                isPublic: isPublic,  // Using our consistently parsed boolean
                groupId: metadata?.groupId,
            };

            // Add group name if item belongs to a group
            if (mediaItem.groupId) {
                mediaItem.groupName = await getGroupName(mediaItem.groupId, env);
            }

            return mediaItem;
        });
        
        // Wait for all promises to resolve and filter out null values
        let mediaItems = (await Promise.all(mediaPromises)).filter((item): item is MediaItem => item !== null);
        
        // If userId is provided, filter media based on access permissions
        if (userId) {
            const user = await getUser(userId, env);
            
            // If user is admin, they can see everything
            if (user && (user.isAdmin || user.userType === UserType.Admin)) {
                return mediaItems;
            }
            
            // For non-admin users, filter based on access rights
            mediaItems = await Promise.all(
                mediaItems.map(async (item) => {
                    // Public items are always visible
                    if (item.isPublic === true) {
                        return item;
                    }
                    
                    // For private items with group access, check group membership
                    if (item.groupId && user) {
                        const canAccess = await canAccessGroup(userId, item.groupId, env);
                        if (canAccess) {
                            return item;
                        }
                    }
                    
                    // User owns the item
                    if (item.uploadedBy === userId) {
                        return item;
                    }
                    
                    return null;
                })
            ).then(items => items.filter((item): item is MediaItem => item !== null));
        } else {
            // No user ID provided, only return public items
            mediaItems = mediaItems.filter(item => item.isPublic === true);
            
            // Log for debugging
            console.log(`Returning ${mediaItems.length} public items for non-logged-in user`);
        }
        
        return mediaItems;
    } catch (error) {
        console.error('Error fetching media from R2:', error);
        return [];
    }
};

// Upload media file and its thumbnail to R2
export const uploadMedia = async (
    mediaFile: File, 
    thumbnailFile: File, 
    userId: string,
    env: Env,
    isPublic: boolean = true,
    groupId?: string
): Promise<{ success: boolean; message: string; mediaItem?: MediaItem }> => {
    try {
        // Generate a unique ID for the file
        const timestamp = Date.now();
        const fileName = `${timestamp}_${mediaFile.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        
        // Define object keys
        const mediaKey = `gallery/${fileName}`;
        const thumbnailKey = `gallery/thumbnails/${fileName}`;
        
        // Get the file data as ArrayBuffer which is compatible with R2
        const mediaBuffer = await mediaFile.arrayBuffer();
        const mediaObject = await env.R2.put(mediaKey, mediaBuffer, {
            httpMetadata: { contentType: mediaFile.type },
            customMetadata: { 
                userId: userId, 
                createdAt: new Date().toISOString(),
                originalName: mediaFile.name,
                fileSize: mediaFile.size.toString(),
                isPublic: isPublic ? 'true' : 'false',
                ...(groupId ? { groupId } : {})
            },
        });
        
        if (!mediaObject) {
            throw new Error('Failed to upload media file');
        }
        
        // Get the thumbnail data as ArrayBuffer which is compatible with R2
        const thumbnailBuffer = await thumbnailFile.arrayBuffer();
        const thumbnailObject = await env.R2.put(thumbnailKey, thumbnailBuffer, {
            httpMetadata: { contentType: thumbnailFile.type },
            customMetadata: { 
                userId: userId, 
                createdAt: new Date().toISOString(),
                isThumbail: 'true',
                originalMediaKey: mediaKey,
            },
        });
        
        if (!thumbnailObject) {
            // If thumbnail upload fails, try to delete the original file
            await env.R2.delete(mediaKey);
            throw new Error('Failed to upload thumbnail');
        }
        
        // Create and return a MediaItem object
        const mediaItem: MediaItem = {
            id: mediaKey,
            fileName: fileName,
            fileType: mediaFile.type,
            url: `${env.PUBLIC_URL}/gallery/${fileName}`,
            thumbnailUrl: `${env.PUBLIC_URL}/gallery/${fileName}/thumbnail`,
            uploadedBy: userId,
            uploadedAt: new Date().toISOString(),
            size: mediaFile.size,
            isPublic,
            groupId
        };
        
        return { 
            success: true, 
            message: 'Media uploaded successfully', 
            mediaItem 
        };
    } catch (error) {
        console.error('Error uploading media to R2:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred during upload' 
        };
    }
};

// Delete a media item from R2
export const deleteMedia = async (
    mediaId: string,
    env: Env
): Promise<{ success: boolean; message: string }> => {
    try {
        // Check if the media exists
        const mediaKey = mediaId;
        const mediaExists = await env.R2.head(mediaKey);
        
        if (!mediaExists) {
            return { 
                success: false, 
                message: 'Media not found' 
            };
        }
        
        // Delete the media file
        await env.R2.delete(mediaKey);
        
        // Check if a thumbnail exists and delete it too
        const thumbnailKey = mediaKey.replace('gallery/', 'gallery/thumbnails/');
        try {
            const thumbnailExists = await env.R2.head(thumbnailKey);
            if (thumbnailExists) {
                await env.R2.delete(thumbnailKey);
            }
        } catch (error) {
            // Thumbnail doesn't exist or couldn't be deleted
            console.warn('Could not delete thumbnail:', error);
        }
        
        return { 
            success: true, 
            message: 'Media deleted successfully' 
        };
    } catch (error) {
        console.error('Error deleting media from R2:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred during deletion' 
        };
    }
};

// Check if a user is an admin
export const isUserAdmin = async (userId: string, env: Env): Promise<boolean> => {
    try {
        // Get the user's session
        const userKey = `user/${userId}`;
        const userObject = await env.R2.get(userKey);
        
        if (!userObject) {
            return false;
        }
        
        const userData = await userObject.json() as { isAdmin?: boolean };
        return userData.isAdmin === true;
    } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
    }
};
