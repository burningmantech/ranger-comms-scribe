import { Env } from '../utils/sessionManager';
import { PutOptions } from '../storage/objectStore';

/**
 * Read-through cache in front of the object store (`env.STORE`).
 *
 * The cache is a module-level, in-memory TTL map. Values are kept as JSON strings
 * and parsed on every read, so callers always get a fresh copy (as they did with the
 * old D1 `object_cache` table) and can't mutate cached state by accident.
 *
 * `__list__:<prefix>` entries live only in this map. Everything passed to `putObject`
 * (including `__meta__:`, `__exists__:`, `change:` and similar index keys) is durable
 * data and is always written to the store.
 */

interface CacheEntry {
    value: string;      // JSON string of the cached value
    expiresAt: number;  // epoch ms
}

const memoryCache = new Map<string, CacheEntry>();

// Sweep expired entries every N writes so the map can't grow without bound.
const SWEEP_EVERY_N_WRITES = 1000;
let writesSinceSweep = 0;

const now = (): number => Date.now();

const sweepExpired = (): void => {
    const t = now();
    for (const [key, entry] of memoryCache) {
        if (entry.expiresAt < t) {
            memoryCache.delete(key);
        }
    }
};

/**
 * Clear the in-memory cache. Intended for tests (each test should start cold);
 * safe to call at any time since the store remains the source of truth.
 */
export const clearMemoryCache = (): void => {
    memoryCache.clear();
    writesSinceSweep = 0;
};

/** R2-style put options, still accepted by `putObject` and translated to `PutOptions`. */
export interface LegacyPutOptions {
    httpMetadata?: { contentType?: string; cacheControl?: string; [key: string]: any };
    customMetadata?: Record<string, string>;
}

/**
 * Normalize `putObject` options: accepts `PutOptions`, the old R2 shape
 * (`{ httpMetadata, customMetadata }`), `null` or `undefined`.
 */
export const toPutOptions = (options?: PutOptions | LegacyPutOptions | null): PutOptions | undefined => {
    if (!options) {
        return undefined;
    }
    const legacy = options as LegacyPutOptions;
    if (legacy.httpMetadata !== undefined || legacy.customMetadata !== undefined) {
        const translated: PutOptions = {};
        if (legacy.httpMetadata?.contentType) translated.contentType = legacy.httpMetadata.contentType;
        if (legacy.httpMetadata?.cacheControl) translated.cacheControl = legacy.httpMetadata.cacheControl;
        if (legacy.customMetadata) translated.metadata = { ...legacy.customMetadata };
        return translated;
    }
    const modern = options as PutOptions;
    if (modern.contentType === undefined && modern.cacheControl === undefined && modern.metadata === undefined) {
        return undefined;
    }
    return modern;
};

/**
 * Initialize the cache. Nothing to set up for the in-memory cache; kept for API compatibility.
 */
export const initCache = async (_env: Env): Promise<void> => {
    return;
};

/**
 * Get an object from the cache
 * @param key The object key
 * @param env The environment (unused; kept for API compatibility)
 * @returns The cached object value or null if not found or expired
 */
export const getFromCache = async <T>(key: string, _env: Env): Promise<T | null> => {
    try {
        const entry = memoryCache.get(key);
        if (!entry) {
            return null;
        }
        if (entry.expiresAt < now()) {
            memoryCache.delete(key);
            return null;
        }
        return JSON.parse(entry.value) as T;
    } catch (error) {
        console.error(`Error getting object ${key} from cache:`, error);
        return null;
    }
};

/**
 * Set an object in the cache
 * @param key The object key
 * @param value The object value (will be JSON stringified)
 * @param env The environment (unused; kept for API compatibility)
 * @param ttl The cache TTL in seconds (default: 1 hour)
 */
export const setInCache = async (
    key: string,
    value: any,
    _env: Env,
    ttl: number = 3600
): Promise<void> => {
    try {
        const jsonValue = JSON.stringify(value);
        if (jsonValue === undefined) {
            // JSON.stringify(undefined) has no representation; nothing to cache.
            memoryCache.delete(key);
            return;
        }
        memoryCache.set(key, { value: jsonValue, expiresAt: now() + ttl * 1000 });

        writesSinceSweep += 1;
        if (writesSinceSweep >= SWEEP_EVERY_N_WRITES) {
            writesSinceSweep = 0;
            sweepExpired();
        }
    } catch (error) {
        console.error(`Error setting object ${key} in cache:`, error);
    }
};

/**
 * Remove an object from the cache
 * @param key The object key
 * @param env The environment (unused; kept for API compatibility)
 */
export const removeFromCache = async (key: string, _env: Env): Promise<void> => {
    memoryCache.delete(key);
};

/**
 * Invalidate multiple objects matching a prefix from the cache
 * @param prefix The key prefix to match
 * @param env The environment (unused; kept for API compatibility)
 */
export const invalidateCacheWithPrefix = async (prefix: string, _env: Env): Promise<void> => {
    for (const key of Array.from(memoryCache.keys())) {
        if (key.startsWith(prefix)) {
            memoryCache.delete(key);
        }
    }
};

/**
 * Cleanup expired cache entries
 * @param env The environment (unused; kept for API compatibility)
 */
export const cleanupExpiredCache = async (_env: Env): Promise<void> => {
    sweepExpired();
};

/**
 * Invalidate the cached listings that could contain `key`.
 */
const invalidateListCachesFor = async (key: string, env: Env): Promise<void> => {
    const keyParts = key.split('/');
    if (keyParts.length > 1) {
        // For each level of the path, invalidate the corresponding list cache
        let currentPath = '';
        for (let i = 0; i < keyParts.length - 1; i++) {
            if (i > 0) currentPath += '/';
            currentPath += keyParts[i];
            await removeFromCache(`__list__:${currentPath}`, env);
            await removeFromCache(`__list__:${currentPath}/`, env);
        }
    }
    // Always invalidate the empty-prefix listing, which contains everything
    await removeFromCache('__list__:', env);
};

/**
 * Get an object from the store with caching
 *
 * This is the main function for implementing the read-through cache pattern.
 * It first tries the in-memory cache, and if not found or expired,
 * it falls back to the store and updates the cache.
 *
 * @param key The object key
 * @param env The environment with the object store
 * @param ttl Cache TTL in seconds (default: 1 hour)
 * @returns The object or null if not found
 */
export const getObject = async <T>(key: string, env: Env, ttl: number = 3600): Promise<T | null> => {
    try {
        // Try to get the object from cache first
        const cachedObject = await getFromCache<T>(key, env);
        if (cachedObject !== null) {
            return cachedObject;
        }

        // If not in cache, get it from the store
        const object = await env.STORE.get(key);
        if (!object) {
            return null;
        }

        // Parse the JSON content
        const content = await object.json<T>();

        // Store in cache for future requests
        await setInCache(key, content, env, ttl);

        return content;
    } catch (error) {
        console.error(`Error getting object ${key}:`, error);
        return null;
    }
};

/**
 * Put an object in the store and update the cache
 *
 * @param key The object key
 * @param value The object value
 * @param env The environment with the object store
 * @param options Put options: `PutOptions` (`{ contentType, cacheControl, metadata }`),
 *                or the legacy R2 shape (`{ httpMetadata, customMetadata }`)
 * @param ttl Cache TTL in seconds (default: 1 hour)
 */
export const putObject = async (
    key: string,
    value: any,
    env: Env,
    options?: PutOptions | LegacyPutOptions | null,
    ttl: number = 3600
): Promise<void> => {
    try {
        // Convert the object to a string for the store
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);

        // Store durably
        await env.STORE.put(key, stringValue, toPutOptions(options));

        // Also store in cache
        await setInCache(key, value, env, ttl);

        // Invalidate any list caches that might contain this object
        await invalidateListCachesFor(key, env);
    } catch (error) {
        console.error(`Error putting object ${key}:`, error);
        throw error; // Rethrow to maintain the same error behavior as the store
    }
};

/**
 * Delete an object from the store and cache
 *
 * @param key The object key
 * @param env The environment with the object store
 */
export const deleteObject = async (key: string, env: Env): Promise<void> => {
    try {
        // Delete from the store
        await env.STORE.delete(key);

        // Also remove from cache
        await removeFromCache(key, env);

        // Invalidate any list caches that might contain this object
        await invalidateListCachesFor(key, env);
    } catch (error) {
        console.error(`Error deleting object ${key}:`, error);
        throw error; // Rethrow to maintain the same error behavior as the store
    }
};

/**
 * List objects with a given prefix, using cache when available
 *
 * Returns `{ objects: [{ key, size, uploaded, etag, metadata, ... }] }` with every key
 * under the prefix (the store paginates internally). On a cache hit `uploaded` is an
 * ISO string rather than a Date, as it was with the old D1 cache.
 *
 * @param prefix The key prefix to list
 * @param env The environment with the object store
 * @param ttl Cache TTL in seconds (default: 5 minutes since listings change often)
 * @returns The list result
 */
export const listObjects = async (prefix: string, env: Env, ttl: number = 300): Promise<any> => {
    try {
        // Create a cache key specifically for this listing operation
        const cacheKey = `__list__:${prefix}`;

        // Try to get the listing from cache first
        const cachedListing = await getFromCache(cacheKey, env);
        if (cachedListing !== null) {
            return cachedListing;
        }

        // If not in cache, get from the store
        const listing = await env.STORE.list(prefix);

        // Store in cache for future requests with a shorter TTL
        await setInCache(cacheKey, listing, env, ttl);

        return listing;
    } catch (error) {
        console.error(`Error listing objects with prefix ${prefix}:`, error);
        throw error; // Rethrow to maintain the same error behavior as the store
    }
};
