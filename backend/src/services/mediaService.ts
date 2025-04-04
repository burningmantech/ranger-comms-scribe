import { GetSession, Env } from '../utils/sessionManager';
import { MediaItem, UserType } from '../types';
import { getUser, canAccessGroup } from '../services/userService';

// Get all media from the gallery folder in R2
export const getMedia = async (env: Env, userId?: string): Promise<MediaItem[]> => {
    try {
        // List all objects with the gallery/ prefix
        const objects = await env.R2.list({ prefix: 'gallery/' });
        
        // Create a list of promises to get each object's metadata
        const mediaPromises = objects.objects.map(async (object) => {
            // Skip thumbnail files when listing (they'll be included with their main file)
            if (object.key.includes('thumbnails')) {
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
                    // Create a URL for the thumbnail
                    thumbnailUrl = `${env.PUBLIC_URL}/gallery/${object.key.split('/').pop()}/thumbnail`;
                }
            } catch (error) {
                // Thumbnail doesn't exist, use a default or empty string
                thumbnailUrl = '';
            }
            
            // Get the file name and extension
            const fileName = object.key.split('/').pop() || '';
            const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
            
            // Infer file type from extension if httpMetadata is not available
            let fileType = object.httpMetadata?.contentType || '';
            
            if (!fileType || fileType === 'application/octet-stream') {
                // Map common extensions to MIME types
                const extensionToMimeType: Record<string, string> = {
                    'jpg': 'image/jpeg',
                    'jpeg': 'image/jpeg',
                    'png': 'image/png',
                    'gif': 'image/gif',
                    'webp': 'image/webp',
                    'svg': 'image/svg+xml',
                    'mp4': 'video/mp4',
                    'webm': 'video/webm',
                    'mov': 'video/quicktime',
                    'avi': 'video/x-msvideo',
                    'mkv': 'video/x-matroska'
                };
                
                fileType = extensionToMimeType[fileExtension] || 'application/octet-stream';
            }
            
            // Create a MediaItem object
            return {
                id: object.key,
                fileName: fileName,
                fileType: fileType,
                url: `${env.PUBLIC_URL}/gallery/${object.key.split('/').pop()}`,
                thumbnailUrl: thumbnailUrl,
                uploadedBy: metadata?.userId || 'unknown',
                uploadedAt: metadata?.createdAt || new Date().toISOString(),
                size: object.size,
            } as MediaItem;
        });
        
        // Wait for all promises to resolve and filter out null values (thumbnails)
        let mediaItems = (await Promise.all(mediaPromises)).filter(item => item !== null) as MediaItem[];
        
        // Get the isPublic value from metadata for each item
        mediaItems = await Promise.all(mediaItems.map(async (item) => {
            // If isPublic is not set in the item, check the metadata
            try {
                const objectMetadata = await env.R2.head(item.id);
                if (objectMetadata && objectMetadata.customMetadata) {
                    // Check if isPublic is explicitly set to 'true' or 'false'
                    let isPublic = true; // Default to true for backward compatibility
                    
                    if (objectMetadata.customMetadata.isPublic === 'false') {
                        isPublic = false;
                    } else if (objectMetadata.customMetadata.isPublic === 'true') {
                        isPublic = true;
                    }
                    
                    return {
                        ...item,
                        isPublic,
                        groupId: objectMetadata.customMetadata.groupId
                    };
                }
            } catch (error) {
                console.warn(`Could not get metadata for ${item.id}:`, error);
            }
            
            // Default to true for backward compatibility if metadata check fails
            return {
                ...item,
                isPublic: true
            };
        }));
        
        // If userId is provided, filter media based on access permissions
        if (userId) {
            console.log('User ID provided:', userId);
            const user = await getUser(userId, env);
            
            // If user is admin, they can see all media
            if (user && user.userType === UserType.Admin) {
                // No filtering needed, admins see everything
            } else {
                // Filter media based on access
                mediaItems = await Promise.all(
                    mediaItems.map(async (item) => {
                        // Public items are visible to everyone
                        if (item.isPublic) return item;
                        
                        // Group items require membership check
                        if (item.groupId && user) {
                            const canAccess = await canAccessGroup(userId, item.groupId, env);
                            if (canAccess) return item;
                        }
                        
                        return null;
                    })
                ).then(filteredItems => filteredItems.filter(item => item !== null) as MediaItem[]);
            }
        } else {
            console.log('No user ID provided, filtering public items only');
            console.log(userId);
            // No user ID provided, only return public items
            // Use strict equality to ensure we only include items that are explicitly true
            mediaItems = mediaItems.filter(item => item.isPublic === true);
            console.log(`Filtered to ${mediaItems.length} public items`);
            
            // Log all items and their isPublic status for debugging
            console.log('All items before filtering:', mediaItems.map(item => ({
                id: item.id,
                isPublic: item.isPublic,
                fileName: item.fileName
            })));
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
        
        // Upload the original file
        const mediaObject = await env.R2.put(mediaKey, mediaFile.stream(), {
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
        
        // Upload the thumbnail
        const thumbnailObject = await env.R2.put(thumbnailKey, thumbnailFile.stream(), {
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
