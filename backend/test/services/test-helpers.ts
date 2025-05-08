import { Env } from '../../src/utils/sessionManager';
import { BlogPost, BlogComment, BlockedUser, UserType, User } from '../../src/types';
import { initCache } from '../../src/services/cacheService';

// Mock data and utilities for testing
export const mockEnv = (): Env => {
  // Create a mock R2 storage that persists between calls
  const storage: { [key: string]: string } = {};
  
  // Create a shared mock implementation for get that uses the storage directly
  const getMock = jest.fn(async (key: string) => {
    if (!storage[key]) return null;
    return {
      json: async () => JSON.parse(storage[key])
    };
  });
  
  // Create a shared mock implementation for put that updates the storage directly
  const putMock = jest.fn(async (key: string, value: string, options?: any) => {
    storage[key] = value;
    return {};
  });
  
  // Create a shared mock implementation for delete
  const deleteMock = jest.fn(async (key: string) => {
    delete storage[key];
    return {};
  });
  
  // Create a shared mock implementation for list
  const listMock = jest.fn(async (options?: { prefix?: string }) => {
    const prefix = options?.prefix || '';
    const objects = Object.keys(storage)
      .filter(key => key.startsWith(prefix))
      .map(key => ({ 
        key,
        name: key.split('/').pop() || '',
        size: storage[key].length,
        etag: 'etag-' + Math.random().toString(36).substring(2)
      }));
    return { objects };
  });
  
  // Mock D1 cache database
  const cacheStore: { [key: string]: any } = {};
  const mockD1 = {
    exec: jest.fn(async (query: string): Promise<any> => {
      // Mock implementation for creating tables
      return { success: true };
    }),
    prepare: jest.fn((query: string) => {
      // Return object with mock bind and execution methods
      return {
        bind: jest.fn((...params: any[]) => {
          // Create a prepared statement with bound parameters
          const preparedStatement = {
            params,
            
            // For inserting or replacing cache entries
            run: jest.fn(async (): Promise<any> => {
              if (query.includes('INSERT OR REPLACE INTO object_cache')) {
                const key = params[0];
                const value = params[1];
                const lastUpdated = params[2];
                const ttl = params[3];
                
                cacheStore[key] = {
                  value,
                  lastUpdated,
                  ttl
                };
              }
              
              // For deleting cache entries
              if (query.includes('DELETE FROM object_cache')) {
                const searchKey = params[0];
                
                if (query.includes('LIKE')) {
                  // Delete with prefix
                  const prefix = searchKey.replace('%', '');
                  Object.keys(cacheStore).forEach(key => {
                    if (key.startsWith(prefix)) {
                      delete cacheStore[key];
                    }
                  });
                } else {
                  // Delete specific key
                  delete cacheStore[searchKey];
                }
              }
              
              return { success: true };
            }),
            
            // For retrieving cache entries
            first: jest.fn(async (): Promise<any> => {
              if (query.includes('SELECT value, last_updated, ttl FROM object_cache')) {
                const key = params[0];
                if (cacheStore[key]) {
                  return {
                    value: cacheStore[key].value,
                    lastUpdated: cacheStore[key].lastUpdated,
                    ttl: cacheStore[key].ttl
                  };
                }
              }
              return null;
            })
          };
          
          return preparedStatement;
        })
      };
    })
  };
  
  return {
    R2: {
      put: putMock,
      get: getMock,
      head: jest.fn(async (key: string) => {
        return storage[key] ? {} : null;
      }),
      delete: deleteMock,
      list: listMock
    },
    D1: mockD1
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
    groups: ['group1']
  },
  {
    id: 'member@example.com',
    name: 'Member User',
    email: 'member@example.com',
    approved: true,
    isAdmin: false,
    userType: UserType.Member,
    groups: ['group1']
  },
  {
    id: 'public@example.com',
    name: 'Public User',
    email: 'public@example.com',
    approved: true,
    isAdmin: false,
    userType: UserType.Public,
    groups: []
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
    env.R2.put(`user/${user.id}`, JSON.stringify(user));
  });
  
  // Store blog posts
  mockPosts.forEach(post => {
    env.R2.put(`blog/posts/${post.id}`, JSON.stringify(post));
  });
  
  // Store comments
  mockComments.forEach(comment => {
    env.R2.put(`blog/comments/${comment.postId}/${comment.id}`, JSON.stringify(comment));
  });
  
  // Store blocked users
  mockBlockedUsers.forEach(blockedUser => {
    env.R2.put(`blog/blocked-users/${blockedUser.userId}`, JSON.stringify(blockedUser));
  });
};