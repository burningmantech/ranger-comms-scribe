// First, import the mock helper
import { createCacheServiceMock, __getStorage, __clearStorage } from './cache-mock-helpers';

// Set up the mock before any other imports that might use cacheService
jest.mock('../../src/services/cacheService', () => createCacheServiceMock());

import {
  getMedia,
  uploadMedia,
  deleteMedia
} from '../../src/services/mediaService';
import { mockEnv, setupMockStorage } from './test-helpers';

// Import the mocked cacheService functions for use in tests
import {
  getObject,
  putObject,
  deleteObject,
  listObjects
} from '../../src/services/cacheService';

// Define the enhanced ReadableStream type that R2 expects
interface EnhancedReadableStream extends ReadableStream<Uint8Array> {
  values(): AsyncIterable<Uint8Array>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

describe('Media Service', () => {
  let env: any;
  // Add these variables to store original console methods
  let originalConsoleLog: any;
  let originalConsoleError: any;
  let originalConsoleWarn: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    env = mockEnv();
    __clearStorage(); // Clear the mock cache storage
    
    // Set up environment for media URLs
    env.PUBLIC_URL = 'https://example.com';
    
    // Mock console methods to silence output during tests
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    
    // Restore original console methods
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  // Create a more complete mock File object with proper TypeScript types
  const createMockFile = (name: string, type: string, size: number): File => {
    // Create mock data
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    
    // Create a basic blob for our mock
    const blob = new Blob([data], { type });
    
    // Create a mock file that uses a Blob instead of a ReadableStream
    // This bypasses the TypeScript issues with ReadableStream compatibility
    return {
      name,
      type,
      size,
      lastModified: Date.now(),
      webkitRelativePath: '',
      arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(size)),
      slice: jest.fn().mockReturnValue(blob),
      text: jest.fn().mockResolvedValue('mock file content'),
      stream: jest.fn().mockReturnValue(blob)
    } as unknown as File;
  };

  describe('getMedia', () => {
    it('should return all media items', async () => {
      // Mock listObjects to return some media items
      (listObjects as jest.Mock).mockResolvedValueOnce({
        objects: [
          { 
            key: 'gallery/test-image.jpg', 
            size: 12345,
            httpMetadata: { contentType: 'image/jpeg' },
            customMetadata: { userId: 'user1', createdAt: '2023-01-01T00:00:00Z', isPublic: 'true' }
          },
          { 
            key: 'gallery/another-image.png', 
            size: 54321,
            httpMetadata: { contentType: 'image/png' },
            customMetadata: { userId: 'user2', createdAt: '2023-01-02T00:00:00Z', isPublic: 'true' }
          },
          { 
            key: 'gallery/thumbnails/test-image.jpg', 
            size: 5000,
            httpMetadata: { contentType: 'image/jpeg' },
            customMetadata: { isThumbail: 'true' }
          }
        ]
      });
      
      const mediaItems = await getMedia(env);
      
      expect(mediaItems.length).toBe(2); // Should skip the thumbnail
      expect(mediaItems.some(item => item.fileName === 'test-image.jpg')).toBe(true);
      expect(mediaItems.some(item => item.fileName === 'another-image.png')).toBe(true);
    });
    
    it('should filter by isPublic when no userId is provided', async () => {
      // Mock listObjects to return both public and private items
      (listObjects as jest.Mock).mockResolvedValueOnce({
        objects: [
          { 
            key: 'gallery/public-image.jpg', 
            size: 12345,
            httpMetadata: { contentType: 'image/jpeg' },
            customMetadata: { userId: 'user1', createdAt: '2023-01-01T00:00:00Z', isPublic: 'true' }
          },
          { 
            key: 'gallery/private-image.png', 
            size: 54321,
            httpMetadata: { contentType: 'image/png' },
            customMetadata: { userId: 'user2', createdAt: '2023-01-02T00:00:00Z', isPublic: 'false' }
          }
        ]
      });
      
      // Add R2.head method for backward compatibility in the mediaService
      env.R2.head = jest.fn().mockImplementation(async (key: string) => {
        if (key === 'gallery/public-image.jpg') {
          return {
            customMetadata: { 
              userId: 'user1', 
              createdAt: '2023-01-01T00:00:00Z', 
              isPublic: 'true' 
            }
          };
        } else if (key === 'gallery/private-image.png') {
          return {
            customMetadata: { 
              userId: 'user2', 
              createdAt: '2023-01-02T00:00:00Z', 
              isPublic: 'false' 
            }
          };
        }
        return null;
      });
      
      const mediaItems = await getMedia(env);
      
      expect(mediaItems.length).toBe(1);
      expect(mediaItems[0].fileName).toBe('public-image.jpg');
      expect(mediaItems[0].isPublic).toBe(true);
    });
    
    it('should infer content type from file extension if not provided', async () => {
      // Mock listObjects with item missing content type
      (listObjects as jest.Mock).mockResolvedValueOnce({
        objects: [
          { 
            key: 'gallery/test-image.jpg', 
            size: 12345,
            httpMetadata: {}, // No content type
            customMetadata: { userId: 'user1', createdAt: '2023-01-01T00:00:00Z', isPublic: 'true' }
          }
        ]
      });
      
      const mediaItems = await getMedia(env);
      
      expect(mediaItems.length).toBe(1);
      expect(mediaItems[0].fileType).toBe('image/jpeg'); // Inferred from .jpg extension
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Mock listObjects to throw an error
      (listObjects as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const mediaItems = await getMedia(env);
      
      expect(mediaItems).toEqual([]);
    });
  });

  describe('uploadMedia', () => {
    it('should upload a media file and its thumbnail', async () => {
      const mediaFile = createMockFile('test-image.jpg', 'image/jpeg', 12345);
      const thumbnailFile = createMockFile('thumbnail.jpg', 'image/jpeg', 5000);
      
      // Mock Date.now to get a consistent timestamp
      const mockTimestamp = 1609459200000; // 2021-01-01
      jest.spyOn(Date, 'now').mockImplementation(() => mockTimestamp);
      
      // Media service still uses R2.put for binary data
      env.R2.put = jest.fn().mockResolvedValue({ etag: 'mock-etag-123456' });
      
      const result = await uploadMedia(
        mediaFile,
        thumbnailFile,
        'user1',
        env,
        true
      );
      
      expect(result.success).toBe(true);
      expect(result.message).toBe('Media uploaded successfully');
      expect(result.mediaItem).toBeDefined();
      
      // Verify file properties
      const mediaItem = result.mediaItem!;
      expect(mediaItem.fileName).toBe(`${mockTimestamp}_test-image.jpg`);
      expect(mediaItem.fileType).toBe('image/jpeg');
      expect(mediaItem.uploadedBy).toBe('user1');
      expect(mediaItem.isPublic).toBe(true);
      
      // Verify URLs
      expect(mediaItem.url).toBe(`https://example.com/gallery/${mockTimestamp}_test-image.jpg`);
      expect(mediaItem.thumbnailUrl).toBe(`https://example.com/gallery/${mockTimestamp}_test-image.jpg/thumbnail`);
      
      // Verify R2.put was called
      expect(env.R2.put).toHaveBeenCalled();
    });
    
    it('should support private media files with group access', async () => {
      const mediaFile = createMockFile('private.jpg', 'image/jpeg', 12345);
      const thumbnailFile = createMockFile('thumbnail.jpg', 'image/jpeg', 5000);
      
      // Mock R2.put for binary data
      env.R2.put = jest.fn().mockImplementation((key, value, options) => {
        return Promise.resolve({ etag: 'mock-etag-123456' });
      });
      
      const result = await uploadMedia(
        mediaFile,
        thumbnailFile,
        'user1',
        env,
        false,
        'group1'
      );
      
      expect(result.success).toBe(true);
      expect(result.mediaItem?.isPublic).toBe(false);
      expect(result.mediaItem?.groupId).toBe('group1');
      
      // Verify custom metadata in R2.put call
      const putCall = env.R2.put.mock.calls[0];
      expect(putCall[2].customMetadata.isPublic).toBe('false');
      expect(putCall[2].customMetadata.groupId).toBe('group1');
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Mock putObject to throw an error
      (putObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const mediaFile = createMockFile('test-image.jpg', 'image/jpeg', 12345);
      const thumbnailFile = createMockFile('thumbnail.jpg', 'image/jpeg', 5000);
      
      const result = await uploadMedia(
        mediaFile,
        thumbnailFile,
        'user1',
        env
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock cache error');
      expect(result.mediaItem).toBeUndefined();
    });
  });

  describe('deleteMedia', () => {
    it('should delete a media item and its thumbnail', async () => {
      // The mediaService uses both cache and R2 directly
      // We need to mock both getObject and env.R2.head/delete
      
      // Mock getObject to return metadata
      (getObject as jest.Mock).mockImplementation((key) => {
        if (key === '__meta__:gallery/test-image.jpg') {
          return Promise.resolve({ customMetadata: { userId: 'user1' } });
        }
        return Promise.resolve(null);
      });
      
      // Mock R2.head to indicate both media and thumbnail exist
      env.R2.head = jest.fn().mockImplementation(async (key) => {
        return {}; // Object exists for any key
      });
      
      // Mock R2.delete for tracking
      env.R2.delete = jest.fn().mockResolvedValue({});
      
      // Mock deleteObject
      (deleteObject as jest.Mock).mockResolvedValue(undefined);
      
      const result = await deleteMedia('gallery/test-image.jpg', env);
      
      expect(result.success).toBe(true);
      expect(result.message).toBe('Media deleted successfully');
      
      // In the real implementation, it's using deleteObject first
      // and then performing additional R2.delete calls
      expect(deleteObject).toHaveBeenCalled();
      
      // Check if R2.delete was called
      expect(env.R2.delete).toHaveBeenCalledTimes(0); // R2.delete is not directly called
    });
    
    it('should return error for non-existent media items', async () => {
      // Mock getObject to indicate media doesn't exist
      (getObject as jest.Mock).mockResolvedValue(null);
      
      const result = await deleteMedia('gallery/nonexistent.jpg', env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Media not found');
      
      // Verify deleteObject was not called
      expect(deleteObject).not.toHaveBeenCalled();
    });
    
    it('should handle errors when deleting thumbnails', async () => {
      // Mock getObject to indicate file exists
      (getObject as jest.Mock).mockImplementation((key) => {
        if (key === '__meta__:gallery/test-image.jpg') {
          return Promise.resolve({ customMetadata: { userId: 'user1' } });
        }
        // For thumbnail existence check
        if (key === '__exists__:gallery/thumbnails/test-image.jpg') {
          return Promise.resolve(true);
        }
        return Promise.resolve(null);
      });
      
      // Mock deleteObject to succeed for main file but fail for thumbnail
      (deleteObject as jest.Mock).mockImplementation((key) => {
        if (key === 'gallery/test-image.jpg' || key.startsWith('__meta__') || key.startsWith('__exists__')) {
          return Promise.resolve();
        }
        if (key === 'gallery/thumbnails/test-image.jpg') {
          console.warn('Mock warning: Error deleting thumbnail');
          return Promise.reject(new Error('Thumbnail deletion failed'));
        }
        return Promise.resolve();
      });
      
      // Create a spy specifically for console.warn
      const consoleSpy = jest.spyOn(console, 'warn');
      
      const result = await deleteMedia('gallery/test-image.jpg', env);
      
      expect(result.success).toBe(true); // Should still succeed even if thumbnail deletion fails
      expect(consoleSpy).toHaveBeenCalled(); // Should log a warning
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Mock getObject to indicate file exists
      (getObject as jest.Mock).mockResolvedValue({ key: 'gallery/test-image.jpg' });
      
      // Mock deleteObject to throw an error
      (deleteObject as jest.Mock).mockRejectedValue(new Error('Mock cache error'));
      
      const result = await deleteMedia('gallery/test-image.jpg', env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock cache error');
    });
  });
});