import { Env } from '../utils/sessionManager';
import { BlogPost, MediaItem } from '../types';

/**
 * Migration function to set all existing content to public
 * This ensures backward compatibility with the new group-based access control
 */
export const setExistingContentPublic = async (env: Env): Promise<void> => {
  console.log('Starting migration: Setting all existing content to public');
  
  try {
    // Update blog posts
    const blogObjects = await env.R2.list({ prefix: 'blog/posts/' });
    console.log(`Found ${blogObjects.objects.length} blog posts to update`);
    
    for (const object of blogObjects.objects) {
      const postObject = await env.R2.get(object.key);
      if (!postObject) continue;
      
      const post = await postObject.json() as BlogPost;
      
      // Only update if isPublic field is not already set
      if (post.isPublic === undefined) {
        post.isPublic = true; // Set to public by default
        
        // Save the updated post
        await env.R2.put(object.key, JSON.stringify(post), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: { 
            userId: post.authorId,
            updatedAt: post.updatedAt,
            type: 'blog-post',
          },
        });
        
        console.log(`Updated blog post: ${post.id}`);
      }
    }
    
    // Update media items
    const mediaObjects = await env.R2.list({ prefix: 'gallery/' });
    const mediaItems: string[] = [];
    
    for (const object of mediaObjects.objects) {
      // Skip thumbnail files
      if (object.key.includes('thumbnails')) {
        continue;
      }
      
      mediaItems.push(object.key);
    }
    
    console.log(`Found ${mediaItems.length} media items to update`);
    
    for (const key of mediaItems) {
      const mediaObject = await env.R2.get(key);
      if (!mediaObject) continue;
      
      // Get the metadata
      const metadata = mediaObject.customMetadata || {};
      
      // Check if isPublic is already set in metadata
      if (metadata.isPublic === undefined) {
        // Create a new metadata object with isPublic set to true
        const newMetadata = {
          ...metadata,
          isPublic: 'true', // R2 metadata values must be strings
        };
        
        // Get the content of the media file
        const content = await mediaObject.arrayBuffer();
        
        // Save the media file with updated metadata
        await env.R2.put(key, content, {
          httpMetadata: mediaObject.httpMetadata,
          customMetadata: newMetadata,
        });
        
        console.log(`Updated media item: ${key}`);
      }
    }
    
    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Error during migration:', error);
    throw error;
  }
};
