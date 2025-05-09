import { jest } from '@jest/globals';

// Define a simple Env type for testing purposes
type Env = {
  CACHE?: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string, options?: any) => Promise<void>;
    delete: (key: string) => Promise<void>;
    list: () => Promise<{ keys: Array<{ name: string }> }>;
  };
};

// Using any type to avoid complex type issues with Jest mocks
export interface CacheMockStorage {
  storage: Record<string, string>;
  get: any;
  put: any;
  delete: any;
  list: any;
}

// Create a shared storage object that can be accessed by test helpers
const globalStorage: Record<string, string> = {};

// Helper functions to access and clear the storage for testing
export const __getStorage = () => ({ ...globalStorage });
export const __clearStorage = () => {
  Object.keys(globalStorage).forEach(key => {
    delete globalStorage[key];
  });
};

export function createCacheMocks(): CacheMockStorage {
  // Use the global storage instead of a local one
  
  return {
    storage: globalStorage,
    get: jest.fn((key: string) => Promise.resolve(globalStorage[key] || null)),
    put: jest.fn((key: string, value: string, _options?: any) => {
      globalStorage[key] = value;
      return Promise.resolve();
    }),
    delete: jest.fn((key: string) => {
      delete globalStorage[key];
      return Promise.resolve();
    }),
    list: jest.fn(() => {
      return Promise.resolve({
        keys: Object.keys(globalStorage).map(name => ({ name })),
      });
    }),
  };
}

// Function to create a mock implementation for the entire cacheService module
export function createCacheServiceMock() {
  const mocks = createCacheMocks();
  const { storage, get, put, delete: del, list } = mocks;
  
  // Create mock functions using simple type annotations
  const getObjectMock: any = jest.fn(function getObject<T>(key: string, _env?: Env): Promise<T | null> {
    return get(key).then((value: string | null) => value ? JSON.parse(value) as T : null);
  });
  
  const putObjectMock: any = jest.fn(function putObject<T>(key: string, value: T, _env?: Env): Promise<void> {
    return put(key, JSON.stringify(value));
  });
  
  const deleteObjectMock: any = jest.fn(function deleteObject(key: string, _env?: Env): Promise<void> {
    return del(key);
  });
  
  const listObjectsMock: any = jest.fn(function listObjects(prefix: string, _env?: Env) {
    const keys = Object.keys(globalStorage)
      .filter(key => key.startsWith(prefix));
    
    return Promise.resolve({
      objects: keys.map(key => ({
        key,
        name: key.split('/').pop() || '',
        size: globalStorage[key].length,
        etag: 'etag-' + Math.random().toString(36).substring(2)
      }))
    });
  });
  
  const clearMock: any = jest.fn(function clear(): Promise<void> {
    Object.keys(storage).forEach(key => {
      delete storage[key];
    });
    return Promise.resolve();
  });
  
  return {
    // Raw cache access
    cache: {
      storage,
      get,
      put, 
      delete: del,
      list
    },
    
    // Primary function names based on actual cacheService.ts
    getObject: getObjectMock,
    putObject: putObjectMock,
    deleteObject: deleteObjectMock,
    listObjects: listObjectsMock,
    
    // Legacy function names used in existing tests
    getItem: getObjectMock,
    setItem: putObjectMock,
    removeItem: deleteObjectMock,
    keys: listObjectsMock,
    clear: clearMock,
    
    // Other cache service functions that may be used
    getFromCache: getObjectMock,
    setInCache: putObjectMock,
    removeFromCache: deleteObjectMock,
    initCache: jest.fn(() => Promise.resolve()),
  };
}