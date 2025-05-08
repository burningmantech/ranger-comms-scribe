import {
  getGalleryComments,
  addGalleryComment,
  deleteGalleryComment
} from '../../src/services/galleryCommentService';
import { mockEnv } from './test-helpers';
import { initCache } from '../../src/services/cacheService';
import { GalleryComment } from '../../src/types';

// Mock the blogService as it's used by galleryCommentService
jest.mock('../../src/services/blogService', () => ({
  isUserBlocked: jest.fn().mockResolvedValue(false)
}));

describe('Gallery Comment Service', () => {
  let env: any;
  let originalConsoleLog: any;
  let originalConsoleError: any;
  let originalConsoleWarn: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    env = mockEnv();
    
    // Initialize the cache for testing
    await initCache(env);
    
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

  describe('getGalleryComments', () => {
    it('should return comments for a media item', async () => {
      // Setup mock comments
      const mediaId = 'test-media-id';
      const comment1: GalleryComment = {
        id: 'comment1',
        mediaId,
        content: 'Test comment 1',
        author: 'User 1',
        authorId: 'user1',
        createdAt: '2023-01-02T00:00:00Z',
        isBlocked: false,
        level: 0,
        replies: []
      };
      
      const comment2: GalleryComment = {
        id: 'comment2',
        mediaId,
        content: 'Test comment 2',
        author: 'User 2',
        authorId: 'user2',
        createdAt: '2023-01-01T00:00:00Z',
        isBlocked: false,
        level: 0,
        replies: []
      };
      
      const reply1: GalleryComment = {
        id: 'reply1',
        mediaId,
        content: 'Test reply 1',
        author: 'User 3',
        authorId: 'user3',
        createdAt: '2023-01-03T00:00:00Z',
        isBlocked: false,
        level: 1,
        parentId: 'comment1',
        replies: []
      };

      // Mock R2.list to return objects for the media's comments
      env.R2.list = jest.fn().mockResolvedValue({
        objects: [
          { key: `gallery/comments/${mediaId}/comment1` },
          { key: `gallery/comments/${mediaId}/comment2` },
          { key: `gallery/comments/${mediaId}/reply1` }
        ]
      });

      // Mock R2.get for each comment
      env.R2.get = jest.fn().mockImplementation(async (key: string) => {
        if (key === `gallery/comments/${mediaId}/comment1`) {
          return {
            json: jest.fn().mockResolvedValue(comment1)
          };
        } else if (key === `gallery/comments/${mediaId}/comment2`) {
          return {
            json: jest.fn().mockResolvedValue(comment2)
          };
        } else if (key === `gallery/comments/${mediaId}/reply1`) {
          return {
            json: jest.fn().mockResolvedValue(reply1)
          };
        }
        return null;
      });

      // Get comments
      const comments = await getGalleryComments(mediaId, env);
      
      // Verify comments structure
      expect(comments.length).toBe(2); // Two root comments
      expect(comments[0].id).toBe('comment1'); // Comment 1 first (newest)
      expect(comments[1].id).toBe('comment2'); // Comment 2 second (older)
      expect(comments[0].replies?.length).toBe(1); // Comment 1 has one reply
      expect(comments[0].replies?.[0].id).toBe('reply1'); // The reply ID matches
      
      // Verify caching functionality by checking if R2 was called
      expect(env.R2.list).toHaveBeenCalledTimes(1);
      // With caching implementation, R2.get may be called more times
      expect(env.R2.get).toHaveBeenCalled();
      expect(env.R2.get.mock.calls.length).toBeGreaterThanOrEqual(3);
      
      // Now get comments again, should use the cache
      env.R2.list = jest.fn(); // Reset mock
      env.R2.get = jest.fn(); // Reset mock
      
      const cachedComments = await getGalleryComments(mediaId, env);
      
      // Verify cache was used (R2 not called)
      expect(env.R2.list).not.toHaveBeenCalled();
      expect(env.R2.get).not.toHaveBeenCalled();
      expect(cachedComments.length).toBe(2);
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Mock R2.list to throw an error
      env.R2.list = jest.fn().mockRejectedValue(new Error('Mock R2 error'));
      
      const comments = await getGalleryComments('error-media-id', env);
      
      expect(comments).toEqual([]);
    });
  });

  describe('addGalleryComment', () => {
    it('should add a root comment successfully', async () => {
      const mediaId = 'test-media-id';
      const content = 'New comment';
      const userId = 'user1';
      const userName = 'User 1';
      
      // Mock Math.random for consistent IDs in tests
      const originalRandom = Math.random;
      Math.random = jest.fn().mockReturnValue(0.123456789);
      
      // Mock Date.now for consistent timestamps
      const originalDateNow = Date.now;
      Date.now = jest.fn().mockReturnValue(1609459200000); // 2021-01-01
      
      const originalToISOString = Date.prototype.toISOString;
      Date.prototype.toISOString = jest.fn().mockReturnValue('2021-01-01T00:00:00Z');
      
      const result = await addGalleryComment(
        mediaId,
        content,
        userId,
        userName,
        null, // No parent comment
        0,
        env
      );
      
      // Restore mocked functions
      Math.random = originalRandom;
      Date.now = originalDateNow;
      Date.prototype.toISOString = originalToISOString;
      
      expect(result.success).toBe(true);
      expect(result.comment).toBeDefined();
      expect(result.comment?.mediaId).toBe(mediaId);
      expect(result.comment?.content).toBe(content);
      expect(result.comment?.author).toBe(userName);
      expect(result.comment?.authorId).toBe(userId);
      expect(result.comment?.level).toBe(0);
      expect(result.comment?.parentId).toBeUndefined();
      
      // Verify the comment was stored with the right pattern
      const expectedPattern = `gallery/comments/${mediaId}/comment_1609459200000_`;
      expect(env.R2.put).toHaveBeenCalled();
      
      // Check that at least one call has the expected pattern
      const putCallArgs = env.R2.put.mock.calls.map((call: any[]) => call[0]);
      const hasExpectedPattern = putCallArgs.some((key: string) => key.startsWith(expectedPattern));
      expect(hasExpectedPattern).toBe(true);
    });
    
    it('should add a reply comment successfully', async () => {
      const mediaId = 'test-media-id';
      const content = 'New reply';
      const userId = 'user2';
      const userName = 'User 2';
      const parentId = 'parent-comment-id';
      
      const result = await addGalleryComment(
        mediaId,
        content,
        userId,
        userName,
        parentId,
        1, // Level 1 for a reply
        env
      );
      
      expect(result.success).toBe(true);
      expect(result.comment).toBeDefined();
      expect(result.comment?.mediaId).toBe(mediaId);
      expect(result.comment?.content).toBe(content);
      expect(result.comment?.parentId).toBe(parentId);
      expect(result.comment?.level).toBe(1);
    });
    
    it('should prevent blocked users from commenting', async () => {
      // Import the actual module to mock
      const blogService = require('../../src/services/blogService');
      
      // Mock the isUserBlocked function to return true
      (blogService.isUserBlocked as jest.Mock).mockResolvedValueOnce(true);
      
      const result = await addGalleryComment(
        'test-media-id',
        'Content from blocked user',
        'blocked-user',
        'Blocked User',
        null,
        0,
        env
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('not allowed to comment');
      expect(env.R2.put).not.toHaveBeenCalled();
    });
    
    it('should handle errors gracefully', async () => {
      // Mock R2.put to throw an error
      env.R2.put = jest.fn().mockRejectedValue(new Error('Mock R2 error'));
      
      const result = await addGalleryComment(
        'test-media-id',
        'Test content',
        'user1',
        'User 1',
        null,
        0,
        env
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock R2 error');
    });
  });

  describe('deleteGalleryComment', () => {
    it('should delete a comment successfully', async () => {
      const mediaId = 'test-media-id';
      const commentId = 'test-comment-id';
      const commentKey = `gallery/comments/${mediaId}/${commentId}`;
      
      // Mock the existence of the comment
      env.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          id: commentId,
          mediaId,
          content: 'Content to delete',
          author: 'User',
          authorId: 'user1',
          createdAt: '2023-01-01T00:00:00Z',
          isBlocked: false,
          level: 0
        })
      });
      
      const result = await deleteGalleryComment(mediaId, commentId, env);
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('deleted successfully');
      expect(env.R2.delete).toHaveBeenCalledWith(commentKey);
    });
    
    it('should delete a parent comment and its replies', async () => {
      const mediaId = 'test-media-id';
      const commentId = 'parent-comment-id';
      const commentKey = `gallery/comments/${mediaId}/${commentId}`;
      
      // Mock the parent comment
      env.R2.get = jest.fn().mockImplementation(async (key: string) => {
        if (key === commentKey) {
          return {
            json: jest.fn().mockResolvedValue({
              id: commentId,
              mediaId,
              content: 'Parent comment',
              author: 'User 1',
              authorId: 'user1',
              createdAt: '2023-01-01T00:00:00Z',
              isBlocked: false,
              level: 0,
              // No parentId means this is a root comment
            })
          };
        } else if (key === `gallery/comments/${mediaId}/reply1`) {
          return {
            json: jest.fn().mockResolvedValue({
              id: 'reply1',
              mediaId,
              content: 'Reply 1',
              author: 'User 2',
              authorId: 'user2',
              createdAt: '2023-01-02T00:00:00Z',
              isBlocked: false,
              level: 1,
              parentId: commentId
            })
          };
        } else if (key === `gallery/comments/${mediaId}/reply2`) {
          return {
            json: jest.fn().mockResolvedValue({
              id: 'reply2',
              mediaId,
              content: 'Reply 2',
              author: 'User 3',
              authorId: 'user3',
              createdAt: '2023-01-03T00:00:00Z',
              isBlocked: false,
              level: 1,
              parentId: commentId
            })
          };
        } else if (key === `gallery/comments/${mediaId}/other`) {
          return {
            json: jest.fn().mockResolvedValue({
              id: 'other',
              mediaId,
              content: 'Other comment',
              author: 'User 4',
              authorId: 'user4',
              createdAt: '2023-01-04T00:00:00Z',
              isBlocked: false,
              level: 0,
              // No parentId, different root comment
            })
          };
        }
        return null;
      });
      
      // Mock listing all comments for this media
      env.R2.list = jest.fn().mockResolvedValue({
        objects: [
          { key: `gallery/comments/${mediaId}/${commentId}` },
          { key: `gallery/comments/${mediaId}/reply1` },
          { key: `gallery/comments/${mediaId}/reply2` },
          { key: `gallery/comments/${mediaId}/other` }
        ]
      });
      
      const result = await deleteGalleryComment(mediaId, commentId, env);
      
      expect(result.success).toBe(true);
      
      // Should delete the parent comment and both replies
      expect(env.R2.delete).toHaveBeenCalledWith(`gallery/comments/${mediaId}/${commentId}`);
      expect(env.R2.delete).toHaveBeenCalledWith(`gallery/comments/${mediaId}/reply1`);
      expect(env.R2.delete).toHaveBeenCalledWith(`gallery/comments/${mediaId}/reply2`);
      
      // Should not delete other root comments
      const deleteCallArgs = env.R2.delete.mock.calls.map((call: any[]) => call[0]);
      expect(deleteCallArgs).not.toContain(`gallery/comments/${mediaId}/other`);
    });
    
    it('should return error for non-existent comments', async () => {
      // Mock R2.get to return null (comment doesn't exist)
      env.R2.get = jest.fn().mockResolvedValue(null);
      
      const result = await deleteGalleryComment('test-media-id', 'non-existent-id', env);
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
      expect(env.R2.delete).not.toHaveBeenCalled();
    });
    
    it('should handle R2 errors gracefully', async () => {
      // Mock the existence of the comment
      env.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue({
          id: 'comment-id',
          mediaId: 'test-media-id',
          content: 'Content',
          author: 'User',
          authorId: 'user1',
          createdAt: '2023-01-01T00:00:00Z',
          isBlocked: false,
          level: 0
        })
      });
      
      // Mock R2.delete to throw an error
      env.R2.delete = jest.fn().mockRejectedValue(new Error('Mock R2 error'));
      
      const result = await deleteGalleryComment('test-media-id', 'comment-id', env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock R2 error');
    });
  });
});