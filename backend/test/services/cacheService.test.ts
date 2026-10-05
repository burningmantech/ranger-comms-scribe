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
  listObjects,
  clearMemoryCache,
  toPutOptions,
} from '../../src/services/cacheService';
import { mockEnv } from './test-helpers';
import { storedJson } from '../helpers/mockObjectStore';

describe('Cache Service', () => {
  let env: any;
  let nowSpy: jest.SpyInstance | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    env = mockEnv(); // also clears the in-memory cache
  });

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = undefined;
    jest.restoreAllMocks();
  });

  const advanceTime = (ms: number) => {
    const base = Date.now();
    nowSpy?.mockRestore();
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base + ms);
  };

  describe('initCache', () => {
    it('is a no-op that resolves', async () => {
      await expect(initCache(env)).resolves.toBeUndefined();
      expect(env.STORE.put).not.toHaveBeenCalled();
    });
  });

  describe('getFromCache & setInCache', () => {
    it('should get null when item is not in cache', async () => {
      expect(await getFromCache('not-in-cache', env)).toBeNull();
    });

    it('should set and get an item in the cache', async () => {
      const testData = { id: 'test1', name: 'Test Object' };
      await setInCache('test-key', testData, env);
      expect(await getFromCache('test-key', env)).toEqual(testData);
      // Cache-only: nothing written to the store
      expect(env.STORE.put).not.toHaveBeenCalled();
    });

    it('returns a fresh copy each time so callers cannot mutate cached state', async () => {
      await setInCache('copy-key', { nested: { n: 1 } }, env);
      const first = await getFromCache<any>('copy-key', env);
      first.nested.n = 999;
      const second = await getFromCache<any>('copy-key', env);
      expect(second.nested.n).toBe(1);
    });

    it('should expire entries after their TTL', async () => {
      await setInCache('ttl-key', { a: 1 }, env, 60);
      advanceTime(59 * 1000);
      expect(await getFromCache('ttl-key', env)).toEqual({ a: 1 });
      advanceTime(61 * 1000);
      expect(await getFromCache('ttl-key', env)).toBeNull();
    });
  });

  describe('removeFromCache', () => {
    it('should remove an item from the cache', async () => {
      await setInCache('remove-key', { data: 'to be removed' }, env);
      await removeFromCache('remove-key', env);
      expect(await getFromCache('remove-key', env)).toBeNull();
    });
  });

  describe('invalidateCacheWithPrefix', () => {
    it('should remove all items with a given prefix', async () => {
      await setInCache('prefix-key1', { id: 1 }, env);
      await setInCache('prefix-key2', { id: 2 }, env);
      await setInCache('other-key', { id: 3 }, env);

      await invalidateCacheWithPrefix('prefix-', env);

      expect(await getFromCache('prefix-key1', env)).toBeNull();
      expect(await getFromCache('prefix-key2', env)).toBeNull();
      expect(await getFromCache('other-key', env)).toEqual({ id: 3 });
    });
  });

  describe('cleanupExpiredCache', () => {
    it('should remove expired cache entries and keep valid ones', async () => {
      await setInCache('short', { id: 1 }, env, 1);
      await setInCache('long', { id: 2 }, env, 3600);
      advanceTime(5000);

      await cleanupExpiredCache(env);

      expect(await getFromCache('short', env)).toBeNull();
      expect(await getFromCache('long', env)).toEqual({ id: 2 });
    });
  });

  describe('clearMemoryCache', () => {
    it('drops every cached entry but leaves the store untouched', async () => {
      await putObject('keep/me', { v: 1 }, env);
      clearMemoryCache();
      expect(await getFromCache('keep/me', env)).toBeNull();
      expect(await getObject('keep/me', env)).toEqual({ v: 1 }); // re-read from store
      expect(env.STORE.get).toHaveBeenCalledWith('keep/me');
    });
  });

  describe('getObject - Read-through cache pattern', () => {
    it('should get object from cache if available', async () => {
      const testData = { id: 'cached-obj', value: 'from cache' };
      await setInCache('cached-key', testData, env);

      const result = await getObject('cached-key', env);

      expect(result).toEqual(testData);
      expect(env.STORE.get).not.toHaveBeenCalled();
    });

    it('should get object from the store if not in cache and store in cache', async () => {
      const testData = { id: 'store-obj', value: 'from store' };
      env.STORE.get.mockResolvedValueOnce(storedJson('store-key', testData));

      const result = await getObject('store-key', env);

      expect(result).toEqual(testData);
      expect(env.STORE.get).toHaveBeenCalledWith('store-key');
      expect(await getFromCache('store-key', env)).toEqual(testData);
    });

    it('should return null if object not in cache or store', async () => {
      const result = await getObject('non-existent-key', env);
      expect(result).toBeNull();
      expect(env.STORE.get).toHaveBeenCalledWith('non-existent-key');
    });

    it('should return null when the store throws', async () => {
      env.STORE.get.mockRejectedValueOnce(new Error('boom'));
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await getObject('err-key', env)).toBeNull();
    });
  });

  describe('putObject', () => {
    it('should store object in both the store and cache', async () => {
      const testData = { id: 'test-put', value: 'test value' };

      await putObject('put-key', testData, env);

      expect(env.STORE.put).toHaveBeenCalledWith('put-key', JSON.stringify(testData), undefined);
      expect(await getFromCache('put-key', env)).toEqual(testData);
      const stored = await env.STORE.backing.get('put-key');
      expect(await stored.json()).toEqual(testData);
    });

    it('should handle string values correctly', async () => {
      const stringValue = 'just a string';
      await putObject('string-key', stringValue, env);
      expect(env.STORE.put).toHaveBeenCalledWith('string-key', stringValue, undefined);
    });

    it('accepts null options', async () => {
      await putObject('null-opts', { a: 1 }, env, null, 3600);
      expect(env.STORE.put).toHaveBeenCalledWith('null-opts', '{"a":1}', undefined);
    });

    it('translates legacy R2-style options to PutOptions', async () => {
      await putObject('user/a@example.com', { id: 'u1' }, env, {
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-cache' },
        customMetadata: { userId: 'u1' },
      });
      expect(env.STORE.put).toHaveBeenCalledWith('user/a@example.com', '{"id":"u1"}', {
        contentType: 'application/json',
        cacheControl: 'no-cache',
        metadata: { userId: 'u1' },
      });
      const head = await env.STORE.backing.head('user/a@example.com');
      expect(head.contentType).toBe('application/json');
      expect(head.metadata).toEqual({ userId: 'u1' });
    });

    it('passes PutOptions through unchanged', async () => {
      const options = { contentType: 'application/json', metadata: { memberId: 'm1' } };
      await putObject('council_member/m1', { id: 'm1' }, env, options);
      expect(env.STORE.put).toHaveBeenCalledWith('council_member/m1', '{"id":"m1"}', options);
    });

    it('writes durable index keys (__meta__, __exists__, change:...) to the store', async () => {
      await putObject('__meta__:gallery/a.jpg', { customMetadata: { isPublic: 'true' } }, env);
      await putObject('__exists__:gallery/thumbnails/a.jpg', true, env);
      await putObject('change:abc', { id: 'abc' }, env);
      await putObject('tracked_changes:sub1', ['abc'], env);

      for (const key of ['__meta__:gallery/a.jpg', '__exists__:gallery/thumbnails/a.jpg', 'change:abc', 'tracked_changes:sub1']) {
        expect(await env.STORE.backing.head(key)).not.toBeNull();
      }
      // And they survive a cold cache
      clearMemoryCache();
      expect(await getObject('__exists__:gallery/thumbnails/a.jpg', env)).toBe(true);
    });

    it('invalidates cached listings that could contain the key', async () => {
      await env.STORE.backing.put('blog/posts/1', '{}');
      expect((await listObjects('blog/posts/', env)).objects).toHaveLength(1);
      expect((await listObjects('', env)).objects).toHaveLength(1);

      await putObject('blog/posts/2', { id: 2 }, env);

      expect((await listObjects('blog/posts/', env)).objects).toHaveLength(2);
      expect((await listObjects('blog/posts', env)).objects).toHaveLength(2);
      expect((await listObjects('', env)).objects).toHaveLength(2);
    });

    it('rethrows store errors', async () => {
      env.STORE.put.mockRejectedValueOnce(new Error('put failed'));
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await expect(putObject('x', { a: 1 }, env)).rejects.toThrow('put failed');
    });
  });

  describe('toPutOptions', () => {
    it('normalizes empty inputs to undefined', () => {
      expect(toPutOptions(undefined)).toBeUndefined();
      expect(toPutOptions(null)).toBeUndefined();
      expect(toPutOptions({})).toBeUndefined();
    });

    it('translates contentType-only legacy options', () => {
      expect(toPutOptions({ httpMetadata: { contentType: 'application/json' } })).toEqual({
        contentType: 'application/json',
      });
    });
  });

  describe('deleteObject', () => {
    it('should delete object from both the store and cache', async () => {
      await putObject('delete-key', { some: 'data' }, env);

      await deleteObject('delete-key', env);

      expect(env.STORE.delete).toHaveBeenCalledWith('delete-key');
      expect(await getFromCache('delete-key', env)).toBeNull();
      expect(await env.STORE.backing.get('delete-key')).toBeNull();
    });

    it('invalidates cached listings', async () => {
      await putObject('gallery/a.jpg', 'x', env);
      expect((await listObjects('gallery/', env)).objects).toHaveLength(1);
      await deleteObject('gallery/a.jpg', env);
      expect((await listObjects('gallery/', env)).objects).toHaveLength(0);
    });
  });

  describe('listObjects', () => {
    it('should list objects from the store', async () => {
      const mockList = { objects: [{ key: 'obj1', size: 1, uploaded: new Date(), metadata: {} }] };
      env.STORE.list.mockResolvedValueOnce(mockList);

      const result = await listObjects('prefix/', env);

      expect(env.STORE.list).toHaveBeenCalledWith('prefix/');
      expect(result).toEqual(mockList);
    });

    it('returns every key with key/size/uploaded and serves repeats from cache', async () => {
      for (let i = 0; i < 1200; i++) {
        await env.STORE.backing.put(`user/${String(i).padStart(4, '0')}`, '{}');
      }

      const first = await listObjects('user/', env);
      expect(first.objects).toHaveLength(1200);
      expect(first.objects[0]).toMatchObject({ key: 'user/0000', size: 2 });
      expect(first.objects[0].uploaded).toBeDefined();

      const second = await listObjects('user/', env);
      expect(second.objects).toHaveLength(1200);
      expect(env.STORE.list).toHaveBeenCalledTimes(1);
    });
  });

  // Integration test for the complete read-through cache pattern
  describe('Integration', () => {
    it('should demonstrate a complete read-through cache workflow', async () => {
      const testObject = {
        id: 'test-integration',
        name: 'Integration Test',
        data: { value: 42 },
      };
      await env.STORE.backing.put('integration-key', JSON.stringify(testObject));

      // 1. First request - object not in cache, fetched from the store and cached
      const result1 = await getObject('integration-key', env);
      expect(result1).toEqual(testObject);
      expect(env.STORE.get).toHaveBeenCalledTimes(1);

      // 2. Second request - served from cache
      const result2 = await getObject('integration-key', env);
      expect(result2).toEqual(testObject);
      expect(env.STORE.get).toHaveBeenCalledTimes(1);

      // 3. Update the object
      const updatedObject = { ...testObject, name: 'Updated Integration Test' };
      await putObject('integration-key', updatedObject, env);
      expect(env.STORE.put).toHaveBeenCalled();

      // 4. Get the updated object (from cache)
      const result3 = await getObject('integration-key', env);
      expect(result3).toEqual(updatedObject);
      expect(env.STORE.get).toHaveBeenCalledTimes(1);

      // 5. Delete the object
      await deleteObject('integration-key', env);
      expect(env.STORE.delete).toHaveBeenCalledWith('integration-key');

      // 6. Try to get the deleted object
      const result4 = await getObject('integration-key', env);
      expect(result4).toBeNull();
    });
  });
});
