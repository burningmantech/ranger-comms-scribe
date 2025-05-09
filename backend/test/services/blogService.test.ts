// First, import the mock helper
import { createCacheServiceMock, __getStorage, __clearStorage } from './cache-mock-helpers';

// Set up the mock before any other imports that might use cacheService
jest.mock('../../src/services/cacheService', () => createCacheServiceMock());

// Now import other modules that depend on the mock
import { 
  getBlogPosts,
  getBlogPost,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
  getComments,
  addComment,
  deleteComment,
  blockUser,
  unblockUser,
  isUserBlocked,
  getBlockedUsers
} from '../../src/services/blogService';
import { mockEnv, setupMockStorage, mockPosts, mockComments, mockBlockedUsers } from './test-helpers';
import { BlogPost, BlogComment, UserType } from '../../src/types';

// Import the mocked cacheService functions for use in tests
import {
  getObject,
  putObject,
  deleteObject,
  listObjects
} from '../../src/services/cacheService';

// Mock userService
jest.mock('../../src/services/userService', () => ({
  getUser: jest.fn((userId, env) => {
    if (userId === 'admin@example.com') {
      return Promise.resolve({
        id: 'admin@example.com',
        name: 'Admin User',
        email: 'admin@example.com',
        userType: UserType.Admin,
        isAdmin: true,
        groups: ['group1']
      });
    } else if (userId === 'member@example.com') {
      return Promise.resolve({
        id: 'member@example.com',
        name: 'Member User',
        email: 'member@example.com',
        userType: UserType.Member,
        isAdmin: false,
        groups: ['group1']
      });
    } else if (userId === 'public@example.com') {
      return Promise.resolve({
        id: 'public@example.com',
        name: 'Public User',
        email: 'public@example.com',
        userType: UserType.Public,
        isAdmin: false,
        groups: []
      });
    } else if (userId === 'blocked@example.com') {
      return Promise.resolve({
        id: 'blocked@example.com',
        name: 'Blocked User',
        email: 'blocked@example.com',
        userType: UserType.Public,
        isAdmin: false,
        groups: []
      });
    }
    return Promise.resolve(null);
  }),
  canAccessGroup: jest.fn((userId, groupId, env) => {
    if (userId === 'admin@example.com') return Promise.resolve(true);
    if (userId === 'member@example.com' && groupId === 'group1') return Promise.resolve(true);
    return Promise.resolve(false);
  })
}));

describe('Blog Service', () => {
  let env: any;
  const MOCK_DATE_MS = 1609459200000; // 2021-01-01

  beforeEach(() => {
    jest.clearAllMocks();
    env = mockEnv();
    __clearStorage(); // Clear the mock cache storage
    
    // Mock Date.now() for predictable IDs
    const mockDateNow = jest.spyOn(Date, 'now');
    mockDateNow.mockImplementation(() => MOCK_DATE_MS);
    
    // Mock Math.random for predictable IDs
    jest.spyOn(Math, 'random').mockImplementation(() => 0.5);
    
    // Mock Date constructor for predictable timestamps
    const mockDate = new Date('2021-01-01T00:00:00Z');
    jest.spyOn(global, 'Date').mockImplementation(() => mockDate as any);
    mockDate.toISOString = jest.fn(() => '2021-01-01T00:00:00Z');
    
    // Setup mock blog posts in cache instead of R2
    if (mockPosts && mockPosts.length > 0) {
      mockPosts.forEach((post) => {
        putObject(`blog/posts/${post.id}`, post, env);
        putObject(`post:blog/posts/${post.id}`, post, env);
      });
    }
    
    // Setup mock comments in cache instead of R2
    if (mockComments && mockComments.length > 0) {
      mockComments.forEach((comment) => {
        putObject(`blog/comments/${comment.postId}/${comment.id}`, comment, env);
        putObject(`comment:blog/comments/${comment.postId}/${comment.id}`, comment, env);
      });
    }
    
    // Setup mock blocked users in cache instead of R2
    if (mockBlockedUsers && mockBlockedUsers.length > 0) {
      mockBlockedUsers.forEach((blockedUser) => {
        putObject(`blog/blocked-users/${blockedUser.userId}`, blockedUser, env);
        putObject(`blocked:${blockedUser.userId}`, blockedUser, env);
      });
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getBlogPosts', () => {
    it('should return all public posts when no userId is provided', async () => {
      const posts = await getBlogPosts(env);
      
      expect(posts).toHaveLength(2); // Only public posts (post1 and post3)
      expect(posts.map(post => post.id)).toContain('post1');
      expect(posts.map(post => post.id)).not.toContain('post2'); // Group post
      expect(posts.map(post => post.id)).toContain('post3');
    });

    it('should return all posts for admin users', async () => {
      const posts = await getBlogPosts(env, 'admin@example.com');
      
      expect(posts).toHaveLength(3); // Admin sees all posts
      expect(posts.map(post => post.id)).toContain('post1');
      expect(posts.map(post => post.id)).toContain('post2');
      expect(posts.map(post => post.id)).toContain('post3');
    });

    it('should return public posts and group posts for group members', async () => {
      const posts = await getBlogPosts(env, 'member@example.com');
      
      expect(posts).toHaveLength(3); // Member sees public posts and their group posts
      expect(posts.map(post => post.id)).toContain('post1');
      expect(posts.map(post => post.id)).toContain('post2'); // Group post they have access to
      expect(posts.map(post => post.id)).toContain('post3');
    });

    it('should return only public posts for non-members', async () => {
      const posts = await getBlogPosts(env, 'public@example.com');
      
      expect(posts).toHaveLength(2); // Public user sees only public posts
      expect(posts.map(post => post.id)).toContain('post1');
      expect(posts.map(post => post.id)).not.toContain('post2'); // Cannot see group post
      expect(posts.map(post => post.id)).toContain('post3');
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock listObjects to throw an error
      (listObjects as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const posts = await getBlogPosts(env);
      
      expect(posts).toEqual([]);
    });
  });

  describe('getBlogPost', () => {
    it('should return a blog post by ID', async () => {
      const post = await getBlogPost('post1', env);
      
      expect(post).toBeDefined();
      expect(post?.id).toBe('post1');
      expect(post?.title).toBe('Public Post');
    });

    it('should return null for non-existent posts', async () => {
      const post = await getBlogPost('nonexistent', env);
      
      expect(post).toBeNull();
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock getObject to throw an error
      (getObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const post = await getBlogPost('post1', env);
      
      expect(post).toBeNull();
    });
  });

  describe('createBlogPost', () => {
    it('should create a new blog post', async () => {
      const newPostData = {
        title: 'Test Post',
        content: 'This is a test post',
        published: true,
        commentsEnabled: true,
        isPublic: true
      };
      
      const result = await createBlogPost(
        newPostData,
        'admin@example.com',
        'Admin User',
        env
      );
      
      expect(result.success).toBe(true);
      expect(result.post).toBeDefined();
      expect(result.post?.id).toContain('post_1609459200000');
      expect(result.post?.title).toBe('Test Post');
      expect(result.post?.author).toBe('Admin User');
      expect(result.post?.authorId).toBe('admin@example.com');
      expect(result.post?.isPublic).toBe(true);
      
      // Verify the post was stored in R2
      const storedPost = await getBlogPost(result.post!.id, env);
      expect(storedPost).toBeDefined();
      expect(storedPost?.title).toBe('Test Post');
    });

    it('should create a group-restricted blog post', async () => {
      const newPostData = {
        title: 'Group Test Post',
        content: 'This is a test post for a group',
        published: true,
        commentsEnabled: true,
        isPublic: false,
        groupId: 'group1'
      };
      
      const result = await createBlogPost(
        newPostData,
        'admin@example.com',
        'Admin User',
        env
      );
      
      expect(result.success).toBe(true);
      expect(result.post?.isPublic).toBe(false);
      expect(result.post?.groupId).toBe('group1');
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock putObject to throw an error
      (putObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const newPostData = {
        title: 'Error Post',
        content: 'This post will fail',
        published: true,
        commentsEnabled: true
      };
      
      const result = await createBlogPost(
        newPostData,
        'admin@example.com',
        'Admin User',
        env
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock cache error');
    });
  });

  describe('updateBlogPost', () => {
    it('should update an existing blog post', async () => {
      const updates = {
        title: 'Updated Post Title',
        content: 'Updated content',
        published: false
      };
      
      const result = await updateBlogPost('post1', updates, env);
      
      expect(result.success).toBe(true);
      expect(result.post).toBeDefined();
      expect(result.post?.id).toBe('post1');
      expect(result.post?.title).toBe('Updated Post Title');
      expect(result.post?.content).toBe('Updated content');
      expect(result.post?.published).toBe(false);
      expect(result.post?.updatedAt).toBe('2021-01-01T00:00:00Z');
      
      // Verify the post was updated in R2
      const updatedPost = await getBlogPost('post1', env);
      expect(updatedPost?.title).toBe('Updated Post Title');
    });

    it('should return error for non-existent posts', async () => {
      const updates = {
        title: 'Updated Title',
        content: 'Updated content'
      };
      
      const result = await updateBlogPost('nonexistent', updates, env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Blog post not found');
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock putObject to throw an error
      (putObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const updates = {
        title: 'Error Update',
        content: 'This update will fail'
      };
      
      const result = await updateBlogPost('post1', updates, env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock cache error');
    });
  });

  describe('deleteBlogPost', () => {
    it('should delete a blog post and its comments', async () => {
      // First, ensure the post exists
      const postBefore = await getBlogPost('post1', env);
      expect(postBefore).not.toBeNull();
      
      const result = await deleteBlogPost('post1', env);
      
      expect(result.success).toBe(true);
      
      // Verify the post was deleted
      const postAfter = await getBlogPost('post1', env);
      expect(postAfter).toBeNull();
      
      // Verify the comments were deleted
      const comments = await getComments('post1', env);
      expect(comments).toHaveLength(0);
    });

    it('should return error for non-existent posts', async () => {
      const result = await deleteBlogPost('nonexistent', env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Blog post not found');
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock deleteObject to throw an error
      (deleteObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const result = await deleteBlogPost('post1', env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock cache error');
    });
  });

  describe('getComments', () => {
    it('should return all comments for a post', async () => {
      const comments = await getComments('post1', env);
      
      expect(comments).toHaveLength(2);
      expect(comments[0].id).toBe('comment1');
      expect(comments[1].id).toBe('comment2');
    });

    it('should return empty array for posts with no comments', async () => {
      const comments = await getComments('post3', env);
      
      expect(comments).toHaveLength(0);
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock listObjects to throw an error
      (listObjects as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const comments = await getComments('post1', env);
      
      expect(comments).toEqual([]);
    });
  });

  describe('addComment', () => {
    it('should add a comment to a blog post', async () => {
      const result = await addComment(
        'post1',
        'This is a new comment',
        'member@example.com',
        'Member User',
        env
      );
      
      expect(result.success).toBe(true);
      expect(result.comment).toBeDefined();
      expect(result.comment?.postId).toBe('post1');
      expect(result.comment?.content).toBe('This is a new comment');
      expect(result.comment?.author).toBe('Member User');
      expect(result.comment?.authorId).toBe('member@example.com');
      
      // Verify the comment was stored
      const comments = await getComments('post1', env);
      expect(comments.length).toBeGreaterThan(2);
      expect(comments.some(c => c.content === 'This is a new comment')).toBe(true);
    });

    it('should return error when the post does not exist', async () => {
      const result = await addComment(
        'nonexistent',
        'This comment will fail',
        'member@example.com',
        'Member User',
        env
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Blog post not found');
    });

    it('should return error when comments are disabled', async () => {
      const result = await addComment(
        'post3',  // post3 has commentsEnabled: false
        'This comment will fail',
        'member@example.com',
        'Member User',
        env
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Comments are disabled for this post');
    });

    it('should return error when user is blocked', async () => {
      const result = await addComment(
        'post1',
        'This comment will fail',
        'blocked@example.com',
        'Blocked User',
        env
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('You are not allowed to comment on blog posts');
    });

    it('should handle R2 errors gracefully', async () => {
      // First, make sure the post exists in the cache
      await getBlogPost('post1', env);
      
      // Mock putObject to throw an error
      (putObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const result = await addComment(
        'post1',
        'This comment will fail',
        'member@example.com',
        'Member User',
        env
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock cache error');
    });
  });

  describe('deleteComment', () => {
    it('should delete a comment', async () => {
      const result = await deleteComment('post1', 'comment1', env);
      
      expect(result.success).toBe(true);
      
      // Verify the comment was deleted
      const comments = await getComments('post1', env);
      expect(comments.find(c => c.id === 'comment1')).toBeUndefined();
    });

    it('should return error for non-existent comments', async () => {
      const result = await deleteComment('post1', 'nonexistent', env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Comment not found');
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock deleteObject to throw an error
      (deleteObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const result = await deleteComment('post1', 'comment1', env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock cache error');
    });
  });

  describe('blockUser', () => {
    it('should block a user', async () => {
      const result = await blockUser(
        'user-to-block',
        'admin@example.com',
        'Inappropriate behavior',
        env
      );
      
      expect(result.success).toBe(true);
      
      // Verify the user was blocked
      const isBlocked = await isUserBlocked('user-to-block', env);
      expect(isBlocked).toBe(true);
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock putObject to throw an error
      (putObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const result = await blockUser(
        'user-to-block',
        'admin@example.com',
        'Inappropriate behavior',
        env
      );
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock cache error');
    });
  });

  describe('unblockUser', () => {
    it('should unblock a blocked user', async () => {
      // First, ensure the user is blocked
      const isBlockedBefore = await isUserBlocked('blocked@example.com', env);
      expect(isBlockedBefore).toBe(true);
      
      const result = await unblockUser('blocked@example.com', env);
      
      expect(result.success).toBe(true);
      
      // Verify the user was unblocked
      const isBlockedAfter = await isUserBlocked('blocked@example.com', env);
      expect(isBlockedAfter).toBe(false);
    });

    it('should return error for non-blocked users', async () => {
      const result = await unblockUser('not-blocked-user', env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('User is not blocked');
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock deleteObject to throw an error
      (deleteObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const result = await unblockUser('blocked@example.com', env);
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Mock cache error');
    });
  });

  describe('isUserBlocked', () => {
    it('should return true for blocked users', async () => {
      const isBlocked = await isUserBlocked('blocked@example.com', env);
      
      expect(isBlocked).toBe(true);
    });

    it('should return false for non-blocked users', async () => {
      const isBlocked = await isUserBlocked('admin@example.com', env);
      
      expect(isBlocked).toBe(false);
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock getObject to throw an error
      (getObject as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const isBlocked = await isUserBlocked('blocked@example.com', env);
      
      expect(isBlocked).toBe(false);
    });
  });

  describe('getBlockedUsers', () => {
    it('should return all blocked users', async () => {
      const blockedUsers = await getBlockedUsers(env);
      
      expect(blockedUsers).toHaveLength(1);
      expect(blockedUsers[0].userId).toBe('blocked@example.com');
      expect(blockedUsers[0].blockedBy).toBe('admin@example.com');
    });

    it('should handle R2 errors gracefully', async () => {
      // Mock listObjects to throw an error
      (listObjects as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Mock cache error');
      });
      
      const blockedUsers = await getBlockedUsers(env);
      
      expect(blockedUsers).toEqual([]);
    });
  });
});