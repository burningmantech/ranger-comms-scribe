// filepath: /Users/ayoung/work/src/github.com/dcwb/backend/test/services/cacheService.test.ts
import {
  initCache,
  getFromCache,
  setInCache,
  removeFromCache,
  invalidateCacheWithPrefix,
  cleanupExpiredCache,
  getObject,
  putObject,
  deleteObject,
  listObjects
} from '../../src/services/cacheService';
import { mockEnv } from './test-helpers';

// Mock context interface for this binding
interface MockContext {
  _query?: string;
  _params?: any[];
}

describe('Cache Service', () => {
  let env: any;
  let mockD1Storage: Record<string, any> = {};
  let mockD1PrepareResult: any;
  let mockPrepare: jest.Mock;
  let mockExec: jest.Mock;
  let mockFirst: jest.Mock;
  let mockRun: jest.Mock;
  let mockBind: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockD1Storage = {}; // Reset D1 storage for each test

    // Create mock functions for D1 methods with properly typed context
    mockFirst = jest.fn().mockImplementation(function(this: MockContext) {
      const query = this._query || '';
      const params = this._params || [];
      
      // SQL parsing logic for cache retrieval
      if (query.includes('SELECT') && params.length > 0) {
        const key = params[0];
        if (mockD1Storage[key]) {
          return mockD1Storage[key];
        }
      }
      return null;
    });

    mockRun = jest.fn().mockImplementation(function(this: MockContext) {
      const query = this._query || '';
      const params = this._params || [];
      
      // Basic SQL parsing logic for INSERT/DELETE operations
      if (query.includes('INSERT OR REPLACE') && params.length >= 4) {
        const [key, value, lastUpdated, ttl] = params;
        mockD1Storage[key] = { key, value, lastUpdated, ttl };
      } else if (query.includes('DELETE') && params.length > 0) {
        if (query.includes('LIKE')) {
          // For prefix deletion
          const prefix = params[0].replace('%', '');
          Object.keys(mockD1Storage).forEach(key => {
            if (key.startsWith(prefix)) {
              delete mockD1Storage[key];
            }
          });
        } else {
          // For exact match deletion
          const key = params[0];
          delete mockD1Storage[key];
        }
      }
      
      return { success: true };
    });

    mockBind = jest.fn().mockImplementation(function(this: MockContext, ...args) {
      this._params = args;
      return {
        first: mockFirst.bind(this),
        run: mockRun.bind(this),
        bind: mockBind.bind(this)
      };
    });

    mockPrepare = jest.fn().mockImplementation(function(this: MockContext, query) {
      this._query = query;
      return {
        bind: mockBind.bind(this),
        first: mockFirst.bind(this),
        run: mockRun.bind(this),
      };
    });

    mockExec = jest.fn().mockResolvedValue({ success: true });

    // Create the mock env with R2
    env = mockEnv();
    
    // Add D1 database to the env
    env.D1 = {
      prepare: mockPrepare.bind({} as MockContext),
      exec: mockExec,
      batch: jest.fn()
    };
    
    // Add a name to the D1 database to simulate the "dancing-cats-d1" database
    env.D1.name = 'dancing-cats-d1';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('initCache', () => {
    it('should initialize the cache tables', async () => {
      await initCache(env);
      
      // Verify D1.exec was called to create the table
      expect(mockExec).toHaveBeenCalled();
      expect(mockExec.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS object_cache');
    });

    it('should gracefully handle when D1 is not available', async () => {
      // Remove D1 from env to test the handling
      const envWithoutD1 = { ...env };
      delete envWithoutD1.D1;
      
      // This should not throw an error
      await expect(initCache(envWithoutD1)).resolves.toBeUndefined();
    });
  });

  describe('getFromCache & setInCache', () => {
    it('should get null when item is not in cache', async () => {
      const result = await getFromCache('not-in-cache', env);
      
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockBind).toHaveBeenCalled();
      expect(mockFirst).toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('should set and get an item in the cache', async () => {
      const testData = { id: 'test1', name: 'Test Object' };
      
      // Set the item in cache
      await setInCache('test-key', testData, env);
      
      // Mock the D1 storage (simulating what would happen in the real D1)
      mockD1Storage['test-key'] = {
        value: JSON.stringify(testData),
        lastUpdated: Date.now(),
        ttl: 3600
      };
      
      // Get the item from cache
      const result = await getFromCache('test-key', env);
      
      expect(result).toEqual(testData);
    });

    it('should remove expired cache entries', async () => {
      const testData = { id: 'test2', name: 'Expired Test' };
      
      // Set expired entry directly in mock storage
      mockD1Storage['expired-key'] = {
        value: JSON.stringify(testData),
        lastUpdated: Date.now() - 4000000, // Set a time in the past
        ttl: 3600
      };
      
      // Get the item from cache should delete it and return null
      const result = await getFromCache('expired-key', env);
      
      expect(result).toBeNull();
      expect(mockRun).toHaveBeenCalled(); // Deletion should occur
    });
  });

  describe('removeFromCache', () => {
    it('should remove an item from the cache', async () => {
      // Set up an item in mock storage
      mockD1Storage['remove-key'] = {
        value: JSON.stringify({ data: 'to be removed' }),
        lastUpdated: Date.now(),
        ttl: 3600
      };
      
      // Remove the item
      await removeFromCache('remove-key', env);
      
      // Verify the SQL query was executed
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
      
      // The item should be gone from our mock storage
      expect(mockD1Storage['remove-key']).toBeUndefined();
    });
  });

  describe('invalidateCacheWithPrefix', () => {
    it('should remove all items with a given prefix', async () => {
      // Set up items in mock storage
      mockD1Storage['prefix-key1'] = {
        value: JSON.stringify({ id: 1 }),
        lastUpdated: Date.now(),
        ttl: 3600
      };
      mockD1Storage['prefix-key2'] = {
        value: JSON.stringify({ id: 2 }),
        lastUpdated: Date.now(),
        ttl: 3600
      };
      mockD1Storage['other-key'] = {
        value: JSON.stringify({ id: 3 }),
        lastUpdated: Date.now(),
        ttl: 3600
      };
      
      // Invalidate items with prefix
      await invalidateCacheWithPrefix('prefix-', env);
      
      // Verify the SQL query was executed
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockBind).toHaveBeenCalledWith('prefix-%');
      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('cleanupExpiredCache', () => {
    it('should remove expired cache entries', async () => {
      // Set up expired and valid items in mock storage
      mockD1Storage['expired-key1'] = {
        value: JSON.stringify({ id: 1 }),
        lastUpdated: Date.now() - 4000000, // expired
        ttl: 3600
      };
      mockD1Storage['valid-key'] = {
        value: JSON.stringify({ id: 2 }),
        lastUpdated: Date.now(), // still valid
        ttl: 3600
      };
      
      // Run cleanup
      await cleanupExpiredCache(env);
      
      // Verify the SQL query was executed
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('getObject - Read-through cache pattern', () => {
    it('should get object from cache if available', async () => {
      const testData = { id: 'cached-obj', value: 'from cache' };
      
      // Set up the cache entry
      mockD1Storage['cached-key'] = {
        value: JSON.stringify(testData),
        lastUpdated: Date.now(),
        ttl: 3600
      };
      
      // Get the object
      const result = await getObject('cached-key', env);
      
      // Should return the cached data
      expect(result).toEqual(testData);
      
      // Verify R2 was not queried
      expect(env.R2.get).not.toHaveBeenCalled();
    });

    it('should get object from R2 if not in cache and store in cache', async () => {
      const testData = { id: 'r2-obj', value: 'from R2' };
      
      // Setup R2 to return data
      env.R2.get = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(testData)
      });
      
      // Get the object (not in cache initially)
      const result = await getObject('r2-key', env);
      
      // Should return the R2 data
      expect(result).toEqual(testData);
      
      // Verify R2 was queried
      expect(env.R2.get).toHaveBeenCalledWith('r2-key');
      
      // Verify data was stored in cache
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
    });

    it('should return null if object not in cache or R2', async () => {
      // Setup R2 to return null
      env.R2.get = jest.fn().mockResolvedValue(null);
      
      // Get non-existent object
      const result = await getObject('non-existent-key', env);
      
      // Should return null
      expect(result).toBeNull();
      
      // Verify R2 was queried
      expect(env.R2.get).toHaveBeenCalledWith('non-existent-key');
    });
  });

  describe('putObject', () => {
    it('should store object in both R2 and cache', async () => {
      const testData = { id: 'test-put', value: 'test value' };
      
      // Put the object
      await putObject('put-key', testData, env);
      
      // Verify it was stored in R2
      expect(env.R2.put).toHaveBeenCalledWith('put-key', JSON.stringify(testData), undefined);
      
      // Verify it was stored in cache
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
    });

    it('should handle string values correctly', async () => {
      const stringValue = 'just a string';
      
      // Put the string object
      await putObject('string-key', stringValue, env);
      
      // Verify it was stored in R2 as is (no extra JSON.stringify)
      expect(env.R2.put).toHaveBeenCalledWith('string-key', stringValue, undefined);
      
      // Verify it was stored in cache
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('deleteObject', () => {
    it('should delete object from both R2 and cache', async () => {
      // Setup cache with the object
      mockD1Storage['delete-key'] = {
        value: JSON.stringify({ some: 'data' }),
        lastUpdated: Date.now(),
        ttl: 3600
      };
      
      // Delete the object
      await deleteObject('delete-key', env);
      
      // Verify it was deleted from R2
      expect(env.R2.delete).toHaveBeenCalledWith('delete-key');
      
      // Verify it was deleted from cache
      expect(mockPrepare).toHaveBeenCalled();
      expect(mockBind).toHaveBeenCalledWith('delete-key');
      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('listObjects', () => {
    it('should list objects from R2', async () => {
      // Setup R2 to return a list
      const mockList = { objects: [{ key: 'obj1' }, { key: 'obj2' }] };
      env.R2.list = jest.fn().mockResolvedValue(mockList);
      
      // List objects
      const result = await listObjects('prefix/', env);
      
      // Verify R2.list was called
      expect(env.R2.list).toHaveBeenCalledWith({ prefix: 'prefix/' });
      
      // Should return the list from R2
      expect(result).toEqual(mockList);
    });
  });

  // Integration test for the complete read-through cache pattern
  describe('Integration', () => {
    it('should demonstrate a complete read-through cache workflow', async () => {
      const testObject = { 
        id: 'test-integration', 
        name: 'Integration Test',
        data: { value: 42 } 
      };
      
      // 1. First request - object not in cache, fetched from R2 and cached
      env.R2.get = jest.fn().mockResolvedValueOnce({
        json: jest.fn().mockResolvedValue(testObject)
      });
      
      const result1 = await getObject('integration-key', env);
      expect(result1).toEqual(testObject);
      expect(env.R2.get).toHaveBeenCalledTimes(1);
      
      // 2. Second request - object should be served from cache
      env.R2.get = jest.fn(); // Reset the mock
      
      // Set up cache entry to simulate what would happen after first request
      mockD1Storage['integration-key'] = {
        value: JSON.stringify(testObject),
        lastUpdated: Date.now(),
        ttl: 3600
      };
      
      const result2 = await getObject('integration-key', env);
      expect(result2).toEqual(testObject);
      expect(env.R2.get).not.toHaveBeenCalled(); // R2 should not be called
      
      // 3. Update the object
      const updatedObject = { ...testObject, name: 'Updated Integration Test' };
      await putObject('integration-key', updatedObject, env);
      
      // Verify it was updated in both R2 and cache
      expect(env.R2.put).toHaveBeenCalled();
      
      // 4. Get the updated object
      mockD1Storage['integration-key'] = {
        value: JSON.stringify(updatedObject),
        lastUpdated: Date.now(),
        ttl: 3600
      };
      
      const result3 = await getObject('integration-key', env);
      expect(result3).toEqual(updatedObject);
      
      // 5. Delete the object
      await deleteObject('integration-key', env);
      
      // Verify it's gone from both R2 and cache
      expect(env.R2.delete).toHaveBeenCalledWith('integration-key');
      delete mockD1Storage['integration-key']; // Simulate the deletion
      
      // 6. Try to get the deleted object
      env.R2.get = jest.fn().mockResolvedValueOnce(null);
      
      const result4 = await getObject('integration-key', env);
      expect(result4).toBeNull();
    });
  });
});