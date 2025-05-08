import { GetSession, Env } from '../utils/sessionManager';
import { MediaItem, UserType, User } from '../types';
import { getUser, canAccessGroup } from '../services/userService';
import { getObject, putObject, deleteObject, listObjects } from './cacheService';

// Define types for metadata objects
interface MediaMetadata {
    customMetadata?: {
        userId?: string;
        createdAt?: string;
        isPublic?: string;
        groupId?: string;
        takenBy?: string;
        [key: string]: any;
    };
    [key: string]: any;
}

// Define interface for R2 object listing
interface R2ObjectListItem {
    key: string;
    size: number;
    httpMetadata?: {
        contentType?: string;
        [key: string]: any;
    };
    customMetadata?: {
        [key: string]: any;
    };
    [key: string]: any;
}

// Get all media from the gallery folder in R2
export const getMedia = async (env: Env, userId?: string): Promise<MediaItem[]> => {
    try {
        // List all objects with the gallery/ prefix using cacheService
        const objects = await listObjects('gallery/', env);
        
        // Create a list of promises to get each object's metadata
        const mediaPromises = objects.objects.map(async (object: R2ObjectListItem) => {
            // Skip thumbnail, medium, and comment files when listing
            if (object.key.includes('thumbnails') || object.key.includes('medium') || object.key.includes('comments')) {
                return null;
            }
            
            // Get the object's metadata
            // R2 list operation doesn't return full metadata, we need to get it separately
            let metadata = object.customMetadata || {};
            
            // Try to get the object from cache first, then fallback to R2.head
            try {
                // Check cache first for the full object metadata
                const fullObjectMeta = await getObject<MediaMetadata>(`__meta__:${object.key}`, env);
                if (fullObjectMeta && fullObjectMeta.customMetadata) {
                    metadata = fullObjectMeta.customMetadata;
                } else {
                    // If not in cache, use R2.head
                    const fullObject = await env.R2.head(object.key);
                    if (fullObject && fullObject.customMetadata) {
                        metadata = fullObject.customMetadata;
                        // Cache the metadata for future use
                        await putObject(`__meta__:${object.key}`, { customMetadata: metadata }, env, null, 3600);
                    }
                }
            } catch (error) {
                console.warn(`Could not get full metadata for ${object.key}:`, error);
            }
            
            // Check if a thumbnail exists for this file
            const thumbnailKey = object.key.replace('gallery/', 'gallery/thumbnails/');
            let thumbnailUrl = '';
            
            try {
                // Check cache first for thumbnail existence
                const thumbnailExists = await getObject(`__exists__:${thumbnailKey}`, env);
                if (thumbnailExists) {
                    thumbnailUrl = `${env.PUBLIC_URL}/gallery/${object.key.split('/').pop()}/thumbnail`;
                } else {
                    // Fall back to R2.head
                    const thumbnailCheck = await env.R2.head(thumbnailKey);
                    if (thumbnailCheck) {
                        // Create a URL for the thumbnail
                        thumbnailUrl = `${env.PUBLIC_URL}/gallery/${object.key.split('/').pop()}/thumbnail`;
                        // Cache the existence for future queries
                        await putObject(`__exists__:${thumbnailKey}`, true, env, null, 3600);
                    }
                }
            } catch (error) {
                // Thumbnail doesn't exist, use a default or empty string
                thumbnailUrl = '';
            }
            
            // Check if a medium version exists for this file
            const mediumKey = object.key.replace('gallery/', 'gallery/medium/');
            let mediumUrl = '';
            
            try {
                // Check cache first for medium version existence
                const mediumExists = await getObject(`__exists__:${mediumKey}`, env);
                if (mediumExists) {
                    mediumUrl = `${env.PUBLIC_URL}/gallery/${object.key.split('/').pop()}/medium`;
                } else {
                    // Fall back to R2.head
                    const mediumCheck = await env.R2.head(mediumKey);
                    if (mediumCheck) {
                        // Create a URL for the medium version
                        mediumUrl = `${env.PUBLIC_URL}/gallery/${object.key.split('/').pop()}/medium`;
                        // Cache the existence for future queries
                        await putObject(`__exists__:${mediumKey}`, true, env, null, 3600);
                    }
                }
            } catch (error) {
                // Medium version doesn't exist, use a default or empty string
                mediumUrl = '';
            }
            
            // Rest of the function remains the same
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
            
            // Try to get uploader name
            let uploaderName = '';
            if (metadata?.userId) {
                try {
                    const user = await getUser(metadata.userId, env);
                    if (user) {
                        uploaderName = user.name;
                    }
                } catch (error) {
                    console.warn(`Could not get uploader name for ${metadata.userId}:`, error);
                }
            }
            
            // Create a MediaItem object
            return {
                id: object.key,
                fileName: fileName,
                fileType: fileType,
                url: `${env.PUBLIC_URL}/gallery/${object.key.split('/').pop()}`,
                thumbnailUrl: thumbnailUrl,
                mediumUrl: mediumUrl,
                uploadedBy: metadata?.userId || 'unknown',
                uploaderName: uploaderName,
                uploadedAt: metadata?.createdAt || new Date().toISOString(),
                takenBy: metadata?.takenBy || '',
                size: object.size,
            } as MediaItem;
        });
        
        // Wait for all promises to resolve and filter out null values (thumbnails and comments)
        let mediaItems = (await Promise.all(mediaPromises)).filter(item => item !== null) as MediaItem[];
        
        // Get the isPublic value from metadata for each item
        mediaItems = await Promise.all(mediaItems.map(async (item) => {
            // If isPublic is not set in the item, check the metadata
            try {
                // Try to get metadata from cache first
                const metadataKey = `__meta__:${item.id}`;
                let objectMetadata = await getObject<MediaMetadata>(metadataKey, env);
                
                if (!objectMetadata) {
                    // If not in cache, get directly from R2
                    const headResponse = await env.R2.head(item.id);
                    if (headResponse) {
                        // Convert R2 head response to MediaMetadata
                        objectMetadata = {
                            customMetadata: headResponse.customMetadata || {}
                        };
                        // Cache for future queries
                        await putObject(metadataKey, objectMetadata, env, null, 3600);
                    }
                }
                
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
                        groupId: objectMetadata.customMetadata.groupId,
                        takenBy: objectMetadata.customMetadata.takenBy || ''
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
            // No user ID provided, only return public items
            // Filter to only include items where isPublic is strictly true
            mediaItems = mediaItems.filter(item => item.isPublic === true);
            console.log(`Filtered to ${mediaItems.length} public items`);
        }
        
        return mediaItems;
    } catch (error) {
        console.error('Error fetching media from R2:', error);
        return [];
    }
};

// Upload media file, its thumbnail, and medium-sized version to R2
export const uploadMedia = async (
    mediaFile: File, 
    thumbnailFile: File, 
    userId: string,
    env: Env,
    isPublic: boolean = true,
    groupId?: string,
    takenBy?: string,
    mediumFile?: File
): Promise<{ success: boolean; message: string; mediaItem?: MediaItem }> => {
    try {
        // Generate a unique ID for the file
        const timestamp = Date.now();
        const fileName = `${timestamp}_${mediaFile.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        
        // Define object keys
        const mediaKey = `gallery/${fileName}`;
        const thumbnailKey = `gallery/thumbnails/${fileName}`;
        const mediumKey = `gallery/medium/${fileName}`;
        
        // Get the user name for metadata
        let userName = '';
        try {
            const user = await getUser(userId, env);
            if (user) {
                userName = user.name;
            }
        } catch (error) {
            console.warn(`Could not get user name for ${userId}:`, error);
        }
        
        // Create metadata object for this media
        const mediaMetadata = {
            userId: userId, 
            createdAt: new Date().toISOString(),
            originalName: mediaFile.name,
            fileSize: mediaFile.size.toString(),
            isPublic: isPublic ? 'true' : 'false',
            takenBy: takenBy || '',
            ...(groupId ? { groupId } : {})
        };
        
        // Get the file data as ArrayBuffer which is compatible with R2
        const mediaBuffer = await mediaFile.arrayBuffer();
        const mediaOptions = {
            httpMetadata: { contentType: mediaFile.type },
            customMetadata: mediaMetadata
        };
        
        // Use R2 directly for binary data, but cache metadata
        const mediaObject = await env.R2.put(mediaKey, mediaBuffer, mediaOptions);
        
        if (!mediaObject) {
            throw new Error('Failed to upload media file');
        }
        
        // Cache the metadata for future use
        await putObject(`__meta__:${mediaKey}`, { customMetadata: mediaMetadata }, env);
        
        // Get the thumbnail data as ArrayBuffer which is compatible with R2
        const thumbnailBuffer = await thumbnailFile.arrayBuffer();
        const thumbnailMetadata = { 
            userId: userId, 
            createdAt: new Date().toISOString(),
            isThumbail: 'true',
            originalMediaKey: mediaKey,
        };
        const thumbnailOptions = {
            httpMetadata: { contentType: thumbnailFile.type },
            customMetadata: thumbnailMetadata
        };
        
        const thumbnailObject = await env.R2.put(thumbnailKey, thumbnailBuffer, thumbnailOptions);
        
        if (!thumbnailObject) {
            // If thumbnail upload fails, delete the media
            await deleteObject(mediaKey, env);
            throw new Error('Failed to upload thumbnail');
        }
        
        // Cache the existence for future queries
        await putObject(`__exists__:${thumbnailKey}`, true, env);
        
        // Upload medium version if provided by the frontend
        let mediumUrl = '';
        
        if (mediumFile) {
            console.log(`Using client-provided medium file: ${mediumFile.name}`);
            // Upload the provided medium file
            const mediumBuffer = await mediumFile.arrayBuffer();
            const mediumMetadata = { 
                userId: userId, 
                createdAt: new Date().toISOString(),
                isMedium: 'true',
                originalMediaKey: mediaKey,
                isResized: 'true' // Mark that this is a properly resized medium image
            };
            const mediumOptions = {
                httpMetadata: { contentType: mediumFile.type },
                customMetadata: mediumMetadata
            };
            
            const mediumObject = await env.R2.put(mediumKey, mediumBuffer, mediumOptions);
            
            if (mediumObject) {
                mediumUrl = `${env.PUBLIC_URL}/gallery/${fileName}/medium`;
                // Cache the existence for future queries
                await putObject(`__exists__:${mediumKey}`, true, env);
            }
        } else {
            console.log(`No medium file provided for ${fileName}, using original`);
            // If no medium file is provided, use the original file
            const mediumMetadata = { 
                userId: userId, 
                createdAt: new Date().toISOString(),
                isMedium: 'true',
                originalMediaKey: mediaKey,
                isResized: 'false' // Mark that this is not a resized medium image
            };
            const mediumOptions = {
                httpMetadata: { contentType: mediaFile.type },
                customMetadata: mediumMetadata
            };
            
            const mediumObject = await env.R2.put(mediumKey, mediaBuffer, mediumOptions);
            
            if (mediumObject) {
                mediumUrl = `${env.PUBLIC_URL}/gallery/${fileName}/medium`;
                // Cache the existence for future queries
                await putObject(`__exists__:${mediumKey}`, true, env);
            }
        }
        
        // Create and return a MediaItem object
        const mediaItem: MediaItem = {
            id: mediaKey,
            fileName: fileName,
            fileType: mediaFile.type,
            url: `${env.PUBLIC_URL}/gallery/${fileName}`,
            thumbnailUrl: `${env.PUBLIC_URL}/gallery/${fileName}/thumbnail`,
            mediumUrl: mediumUrl,
            uploadedBy: userId,
            uploaderName: userName,
            uploadedAt: new Date().toISOString(),
            takenBy: takenBy || '',
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
        // Try cache first
        let mediaExists = await getObject(`__meta__:${mediaKey}`, env);
        if (!mediaExists) {
            // If not in cache, check R2 directly
            mediaExists = await env.R2.head(mediaKey);
        }
        
        if (!mediaExists) {
            return { 
                success: false, 
                message: 'Media not found' 
            };
        }
        
        // Delete the media file and associated cache entries
        await deleteObject(mediaKey, env);
        await removeExistenceCache(mediaKey, env);
        
        // Check if a thumbnail exists and delete it too
        const thumbnailKey = mediaKey.replace('gallery/', 'gallery/thumbnails/');
        try {
            // Check cache first
            let thumbnailExists = await getObject(`__exists__:${thumbnailKey}`, env);
            if (!thumbnailExists) {
                // If not in cache, check R2 directly
                thumbnailExists = await env.R2.head(thumbnailKey);
            }
            
            if (thumbnailExists) {
                await deleteObject(thumbnailKey, env);
                await removeExistenceCache(thumbnailKey, env);
            }
        } catch (error) {
            // Thumbnail doesn't exist or couldn't be deleted
            console.warn('Could not delete thumbnail:', error);
        }
        
        // Check if a medium version exists and delete it too
        const mediumKey = mediaKey.replace('gallery/', 'gallery/medium/');
        try {
            // Check cache first
            let mediumExists = await getObject(`__exists__:${mediumKey}`, env);
            if (!mediumExists) {
                // If not in cache, check R2 directly
                mediumExists = await env.R2.head(mediumKey);
            }
            
            if (mediumExists) {
                await deleteObject(mediumKey, env);
                await removeExistenceCache(mediumKey, env);
            }
        } catch (error) {
            // Medium version doesn't exist or couldn't be deleted
            console.warn('Could not delete medium version:', error);
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

// Helper function to remove cache entries for file existence checks
async function removeExistenceCache(key: string, env: Env): Promise<void> {
    try {
        await deleteObject(`__exists__:${key}`, env);
        await deleteObject(`__meta__:${key}`, env);
    } catch (error) {
        console.warn(`Error removing existence cache for ${key}:`, error);
    }
}

// Check if a user is an admin
export const isUserAdmin = async (userId: string, env: Env): Promise<boolean> => {
    try {
        // Get the user's data using cacheService
        const userKey = `user/${userId}`;
        const userData = await getObject(userKey, env) as User;
        
        if (!userData) {
            return false;
        }
        
        return userData.isAdmin === true;
    } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
    }
};
