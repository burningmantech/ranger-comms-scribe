import { Env } from '../../src/utils/sessionManager';
import { BlogPost, BlogComment, BlockedUser, UserType, User } from '../../src/types';
import { clearMemoryCache } from '../../src/services/cacheService';
import { createMockObjectStore } from '../helpers/mockObjectStore';

// Mock data and utilities for testing
export const mockEnv = (): Env => {
  // Each env starts with an empty store and a cold in-memory cache.
  // (Guarded because some suites replace cacheService with a jest mock.)
  if (typeof clearMemoryCache === 'function') {
    clearMemoryCache();
  }

  return {
    STORE: createMockObjectStore(),
    // Add other env properties as needed
  } as unknown as Env;
};

// Mock user data
export const mockUsers: User[] = [
  {
    id: 'admin@example.com',
    name: 'Admin User',
    email: 'admin@example.com',
    approved: true,
    isAdmin: true,
    userType: UserType.Admin,
    groups: ['group1'],
    roles: ['Admin']
  },
  {
    id: 'member@example.com',
    name: 'Member User',
    email: 'member@example.com',
    approved: true,
    isAdmin: false,
    userType: UserType.Member,
    groups: ['group1'],
    roles: ['Member']
  },
  {
    id: 'public@example.com',
    name: 'Public User',
    email: 'public@example.com',
    approved: true,
    isAdmin: false,
    userType: UserType.Public,
    groups: [],
    roles: ['Public']
  }
];

// Mock blog posts
export const mockPosts: BlogPost[] = [
  {
    id: 'post1',
    title: 'Public Post',
    content: 'This is a public post',
    author: 'Admin User',
    authorId: 'admin@example.com',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    published: true,
    commentsEnabled: true,
    isPublic: true,
    media: []
  },
  {
    id: 'post2',
    title: 'Group Post',
    content: 'This is a group post',
    author: 'Admin User',
    authorId: 'admin@example.com',
    createdAt: '2023-01-02T00:00:00Z',
    updatedAt: '2023-01-02T00:00:00Z',
    published: true,
    commentsEnabled: true,
    isPublic: false,
    groupId: 'group1',
    media: []
  },
  {
    id: 'post3',
    title: 'Draft Post',
    content: 'This is a draft post',
    author: 'Admin User',
    authorId: 'admin@example.com',
    createdAt: '2023-01-03T00:00:00Z',
    updatedAt: '2023-01-03T00:00:00Z',
    published: false,
    commentsEnabled: false,
    isPublic: true,
    media: []
  }
];

// Mock comments
export const mockComments: BlogComment[] = [
  {
    id: 'comment1',
    postId: 'post1',
    content: 'Great post!',
    author: 'Member User',
    authorId: 'member@example.com',
    createdAt: '2023-01-01T12:00:00Z',
    isBlocked: false
  },
  {
    id: 'comment2',
    postId: 'post1',
    content: 'I agree!',
    author: 'Public User',
    authorId: 'public@example.com',
    createdAt: '2023-01-01T13:00:00Z',
    isBlocked: false
  }
];

// Mock blocked users
export const mockBlockedUsers: BlockedUser[] = [
  {
    userId: 'blocked@example.com',
    blockedAt: '2023-01-10T00:00:00Z',
    blockedBy: 'admin@example.com',
    reason: 'Inappropriate comments'
  }
];

// Setup function to populate the mock storage with test data
export const setupMockStorage = (env: Env): void => {
  // Store users
  mockUsers.forEach(user => {
    env.STORE.put(`user/${user.id}`, JSON.stringify(user));
  });
  
  // Store blog posts
  mockPosts.forEach(post => {
    env.STORE.put(`blog/posts/${post.id}`, JSON.stringify(post));
  });
  
  // Store comments
  mockComments.forEach(comment => {
    env.STORE.put(`blog/comments/${comment.postId}/${comment.id}`, JSON.stringify(comment));
  });
  
  // Store blocked users
  mockBlockedUsers.forEach(blockedUser => {
    env.STORE.put(`blog/blocked-users/${blockedUser.userId}`, JSON.stringify(blockedUser));
  });
};