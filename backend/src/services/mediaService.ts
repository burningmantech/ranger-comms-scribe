import { isAdmin } from './access';
import { GetSession, Env } from '../utils/sessionManager';
import { MediaItem, UserType, User } from '../types';
import { getUser, canAccessGroup } from '../services/userService';
import { getObject, putObject, deleteObject, listObjects, removeFromCache } from './cacheService';
import { ObjectInfo } from '../storage/objectStore';

// Media URLs are stored and returned relative to the site origin
// (/api/gallery/<file>[/thumbnail|/medium]) so saved content survives hostname
// changes. The SPA and API share one origin in AWS; local dev proxies /api.
export const GALLERY_URL_PREFIX = '/api/gallery';

/**
 * Make relative gallery URLs absolute for content that leaves the site (email).
 * Works on HTML attributes and on Lexical JSON ("src":"/api/gallery/...").
 * Stored content stays relative.
 */
export function absolutizeMediaUrls(content: string, publicUrl: string | undefined): string {
    if (!content || !publicUrl) return content;
    let origin: string;
    try {
        origin = new URL(publicUrl).origin;
    } catch {
        return content;
    }
    return content.replace(/(["'(=]\s*)\/api\/gallery\//g, `$1${origin}/api/gallery/`);
}

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

// Get all media from the gallery folder in the object store
export const getMedia = async (env: Env, userId?: string): Promise<MediaItem[]> => {
    try {
        // List all objects with the gallery/ prefix using cacheService
        const objects = await listObjects('gallery/', env);
        
        // Create a list of promises to get each object's metadata
        const mediaPromises = objects.objects.map(async (object: ObjectInfo) => {
            // Skip thumbnail, medium, and comment files when listing
            if (object.key.includes('thumbnails') || object.key.includes('medium') || object.key.includes('comments')) {
                return null;
            }
            
            // Get the object's metadata
            // List operations don't return user metadata, we need to get it separately
            let metadata: Record<string, any> = object.metadata || {};
            
            // Try to get the object from cache first, then fallback to STORE.head
            try {
                // Check cache first for the full object metadata
                const fullObjectMeta = await getObject<MediaMetadata>(`__meta__:${object.key}`, env);
                if (fullObjectMeta && fullObjectMeta.customMetadata) {
                    metadata = fullObjectMeta.customMetadata;
                } else {
                    // If not in cache, use STORE.head
                    const fullObject = await env.STORE.head(object.key);
                    if (fullObject && fullObject.metadata) {
                        metadata = fullObject.metadata;
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
                    thumbnailUrl = `${GALLERY_URL_PREFIX}/${object.key.split('/').pop()}/thumbnail`;
                } else {
                    // Fall back to STORE.head
                    const thumbnailCheck = await env.STORE.head(thumbnailKey);
                    if (thumbnailCheck) {
                        // Create a URL for the thumbnail
                        thumbnailUrl = `${GALLERY_URL_PREFIX}/${object.key.split('/').pop()}/thumbnail`;
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
                    mediumUrl = `${GALLERY_URL_PREFIX}/${object.key.split('/').pop()}/medium`;
                } else {
                    // Fall back to STORE.head
                    const mediumCheck = await env.STORE.head(mediumKey);
                    if (mediumCheck) {
                        // Create a URL for the medium version
                        mediumUrl = `${GALLERY_URL_PREFIX}/${object.key.split('/').pop()}/medium`;
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
            
            // Infer file type from extension if the content type is not available
            let fileType = object.contentType || '';
            
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
                url: `${GALLERY_URL_PREFIX}/${object.key.split('/').pop()}`,
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
                    // If not in cache, get directly from the store
                    const headResponse = await env.STORE.head(item.id);
                    if (headResponse) {
                        // Convert head response to MediaMetadata
                        objectMetadata = {
                            customMetadata: headResponse.metadata || {}
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
            if (user && isAdmin(user)) {
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
        console.error('Error fetching media from store:', error);
        return [];
    }
};

// Upload media file, its thumbnail, and medium-sized version to the object store
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
        
        // Get the file data as ArrayBuffer
        const mediaBuffer = await mediaFile.arrayBuffer();
        const mediaOptions = {
            contentType: mediaFile.type,
            metadata: mediaMetadata
        };
        
        // Use the store directly for binary data (put throws on failure), but cache metadata
        await env.STORE.put(mediaKey, mediaBuffer, mediaOptions);
        
        // Cache the metadata for future use
        await putObject(`__meta__:${mediaKey}`, { customMetadata: mediaMetadata }, env);
        
        // Get the thumbnail data as ArrayBuffer
        const thumbnailBuffer = await thumbnailFile.arrayBuffer();
        const thumbnailMetadata = { 
            userId: userId, 
            createdAt: new Date().toISOString(),
            isThumbail: 'true',
            originalMediaKey: mediaKey,
        };
        const thumbnailOptions = {
            contentType: thumbnailFile.type,
            metadata: thumbnailMetadata
        };
        
        await env.STORE.put(thumbnailKey, thumbnailBuffer, thumbnailOptions);
        
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
                contentType: mediumFile.type,
                metadata: mediumMetadata
            };
            
            await env.STORE.put(mediumKey, mediumBuffer, mediumOptions);
            mediumUrl = `${GALLERY_URL_PREFIX}/${fileName}/medium`;
            // Cache the existence for future queries
            await putObject(`__exists__:${mediumKey}`, true, env);
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
                contentType: mediaFile.type,
                metadata: mediumMetadata
            };
            
            await env.STORE.put(mediumKey, mediaBuffer, mediumOptions);
            mediumUrl = `${GALLERY_URL_PREFIX}/${fileName}/medium`;
            // Cache the existence for future queries
            await putObject(`__exists__:${mediumKey}`, true, env);
        }
        
        // Invalidate gallery listing caches so new uploads appear immediately
        await removeFromCache('__list__:gallery/', env);
        await removeFromCache('__list__:', env);

        // Create and return a MediaItem object
        const mediaItem: MediaItem = {
            id: mediaKey,
            fileName: fileName,
            fileType: mediaFile.type,
            url: `${GALLERY_URL_PREFIX}/${fileName}`,
            thumbnailUrl: `${GALLERY_URL_PREFIX}/${fileName}/thumbnail`,
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
        console.error('Error uploading media to store:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred during upload' 
        };
    }
};

// Delete a media item from the object store
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
            // If not in cache, check the store directly
            mediaExists = await env.STORE.head(mediaKey);
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
                // If not in cache, check the store directly
                thumbnailExists = await env.STORE.head(thumbnailKey);
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
                // If not in cache, check the store directly
                mediumExists = await env.STORE.head(mediumKey);
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
        console.error('Error deleting media from store:', error);
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

