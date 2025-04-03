import { GetSession, Env } from '../utils/sessionManager';
import { MediaItem } from '../types';

// Get all media from the gallery folder in R2
export const getMedia = async (env: Env): Promise<MediaItem[]> => {
    try {
        // List all objects with the gallery/ prefix
        const objects = await env.R2.list({ prefix: 'gallery/' });
        
        // Create a list of promises to get each object's metadata
        const mediaPromises = objects.objects.map(async (object) => {
            // Skip thumbnail files when listing (they'll be included with their main file)
            if (object.key.includes('_thumbnail')) {
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
            
            // Create a MediaItem object
            return {
                id: object.key,
                fileName: object.key.split('/').pop() || '',
                fileType: object.httpMetadata?.contentType || 'application/octet-stream',
                url: `${env.PUBLIC_URL}/gallery/${object.key.split('/').pop()}`,
                thumbnailUrl: thumbnailUrl,
                uploadedBy: metadata?.userId || 'unknown',
                uploadedAt: metadata?.createdAt || new Date().toISOString(),
                size: object.size,
            } as MediaItem;
        });
        
        // Wait for all promises to resolve and filter out null values (thumbnails)
        const mediaItems = (await Promise.all(mediaPromises)).filter(item => item !== null) as MediaItem[];
        
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
    env: Env
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

// Check if a user is an admin
export const isUserAdmin = async (userId: string, env: Env): Promise<boolean> => {
    try {
        // Get the user's session
        const userKey = `user:${userId}`;
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
