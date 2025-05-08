import { Env } from '../utils/sessionManager';

// Interface for cached objects
interface CachedObject {
    key: string;      // R2 object key
    value: string;    // JSON string of the object
    lastUpdated: number; // Timestamp of when the object was last updated
    ttl: number;      // Cache TTL in seconds
}

/**
 * Initialize the D1 cache database tables
 * This should be called during application startup
 */
export const initCache = async (env: Env): Promise<void> => {
    if (!env.D1) {
        console.warn('D1 database not available, caching disabled');
        return;
    }

    try {
        // Create the cache table if it doesn't exist
        await env.D1.exec(`
            CREATE TABLE IF NOT EXISTS object_cache (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                last_updated INTEGER NOT NULL,
                ttl INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_last_updated ON object_cache(last_updated);
        `);
    } catch (error) {
        console.error('Error initializing cache database:', error);
    }
};

/**
 * Get an object from the cache
 * @param key The R2 object key
 * @param env The environment with D1 access
 * @returns The cached object value or null if not found or expired
 */
export const getFromCache = async <T>(key: string, env: Env): Promise<T | null> => {
    if (!env.D1) {
        return null;
    }

    try {
        const result = await env.D1.prepare(
            'SELECT value, last_updated, ttl FROM object_cache WHERE key = ?'
        )
        .bind(key)
        .first<CachedObject>();

        if (!result) {
            return null;
        }

        // Check if the cache entry has expired
        const now = Date.now();
        if (result.lastUpdated + result.ttl * 1000 < now) {
            // Cache entry has expired, remove it
            await removeFromCache(key, env);
            return null;
        }

        // Parse and return the cached value
        return JSON.parse(result.value) as T;
    } catch (error) {
        console.error(`Error getting object ${key} from cache:`, error);
        return null;
    }
};

/**
 * Set an object in the cache
 * @param key The R2 object key
 * @param value The object value (will be JSON stringified)
 * @param env The environment with D1 access
 * @param ttl The cache TTL in seconds (default: 1 hour)
 */
export const setInCache = async (
    key: string, 
    value: any, 
    env: Env, 
    ttl: number = 3600
): Promise<void> => {
    if (!env.D1) {
        return;
    }

    try {
        const jsonValue = JSON.stringify(value);
        const now = Date.now();

        await env.D1.prepare(
            'INSERT OR REPLACE INTO object_cache (key, value, last_updated, ttl) VALUES (?, ?, ?, ?)'
        )
        .bind(key, jsonValue, now, ttl)
        .run();
    } catch (error) {
        console.error(`Error setting object ${key} in cache:`, error);
    }
};

/**
 * Remove an object from the cache
 * @param key The R2 object key
 * @param env The environment with D1 access
 */
export const removeFromCache = async (key: string, env: Env): Promise<void> => {
    if (!env.D1) {
        return;
    }

    try {
        await env.D1.prepare('DELETE FROM object_cache WHERE key = ?')
        .bind(key)
        .run();
    } catch (error) {
        console.error(`Error removing object ${key} from cache:`, error);
    }
};

/**
 * Invalidate multiple objects matching a prefix from the cache
 * @param prefix The key prefix to match
 * @param env The environment with D1 access
 */
export const invalidateCacheWithPrefix = async (prefix: string, env: Env): Promise<void> => {
    if (!env.D1) {
        return;
    }

    try {
        await env.D1.prepare('DELETE FROM object_cache WHERE key LIKE ?')
        .bind(`${prefix}%`)
        .run();
    } catch (error) {
        console.error(`Error invalidating cache with prefix ${prefix}:`, error);
    }
};

/**
 * Cleanup expired cache entries
 * @param env The environment with D1 access
 */
export const cleanupExpiredCache = async (env: Env): Promise<void> => {
    if (!env.D1) {
        return;
    }

    try {
        const now = Date.now();
        await env.D1.prepare('DELETE FROM object_cache WHERE last_updated + ttl * 1000 < ?')
        .bind(now)
        .run();
    } catch (error) {
        console.error('Error cleaning up expired cache entries:', error);
    }
};

/**
 * Get an object from R2 with caching
 * 
 * This is the main function for implementing the read-through cache pattern.
 * It first tries to get the object from D1 cache, and if not found or expired,
 * it falls back to R2 and updates the cache.
 * 
 * @param key The R2 object key
 * @param env The environment with R2 and D1 access
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

        // If not in cache, get it from R2
        const object = await env.R2.get(key);
        if (!object) {
            return null;
        }

        // Parse the JSON content
        const content = await object.json() as T;

        // Store in cache for future requests
        await setInCache(key, content, env, ttl);

        return content;
    } catch (error) {
        console.error(`Error getting object ${key}:`, error);
        return null;
    }
};

/**
 * Put an object in R2 and update the cache
 * 
 * @param key The R2 object key
 * @param value The object value
 * @param env The environment with R2 and D1 access
 * @param options R2 put options
 * @param ttl Cache TTL in seconds (default: 1 hour)
 */
export const putObject = async (
    key: string, 
    value: any, 
    env: Env, 
    options?: any, 
    ttl: number = 3600
): Promise<void> => {
    try {
        // Convert the object to a string for R2
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);

        // Store in R2
        await env.R2.put(key, stringValue, options);

        // Also store in cache
        await setInCache(key, value, env, ttl);
    } catch (error) {
        console.error(`Error putting object ${key}:`, error);
        throw error; // Rethrow to maintain the same error behavior as R2
    }
};

/**
 * Delete an object from R2 and cache
 * 
 * @param key The R2 object key
 * @param env The environment with R2 and D1 access
 */
export const deleteObject = async (key: string, env: Env): Promise<void> => {
    try {
        // Delete from R2
        await env.R2.delete(key);

        // Also remove from cache
        await removeFromCache(key, env);
    } catch (error) {
        console.error(`Error deleting object ${key}:`, error);
        throw error; // Rethrow to maintain the same error behavior as R2
    }
};

/**
 * List objects from R2 with a given prefix
 * This operation is not cached because listing results may change frequently
 * 
 * @param prefix The key prefix to list
 * @param env The environment with R2 access
 * @returns The list result from R2
 */
export const listObjects = async (prefix: string, env: Env): Promise<any> => {
    try {
        return await env.R2.list({ prefix });
    } catch (error) {
        console.error(`Error listing objects with prefix ${prefix}:`, error);
        throw error; // Rethrow to maintain the same error behavior as R2
    }
};