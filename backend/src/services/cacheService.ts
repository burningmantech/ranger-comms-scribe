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
        console.log('Initializing cache database...');
        
        // Create the cache table if it doesn't exist
        // Fix: Put the entire SQL statement on one line without line breaks
        console.log('Creating object_cache table...');
        await env.D1.exec(
            "CREATE TABLE IF NOT EXISTS object_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, last_updated INTEGER NOT NULL, ttl INTEGER NOT NULL)"
        );
        console.log('Object cache table created successfully');
        
        // Create the index in a separate statement
        // Fix: Put the entire SQL statement on one line without line breaks
        console.log('Creating index on last_updated...');
        await env.D1.exec(
            "CREATE INDEX IF NOT EXISTS idx_last_updated ON object_cache(last_updated)"
        );
        console.log('Index created successfully');
        
        // Verify table was created
        const tableCheck = await env.D1.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='object_cache'"
        ).first();
        
        if (tableCheck) {
            console.log('Verified object_cache table exists');
        } else {
            console.error('Failed to create object_cache table - not found after creation');
        }
    } catch (error) {
        console.error('Error initializing cache database:', error);
        // Log more details about the error
        if (error instanceof Error) {
            console.error('Error name:', error.name);
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
        }
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
        
        // Invalidate any list caches that might contain this object
        // We extract potential prefixes from the key path
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
            // Also invalidate the empty prefix list which contains everything
            await removeFromCache('__list__:', env);
        } else {
            // Top-level object, just invalidate the root listing
            await removeFromCache('__list__:', env);
        }
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
        
        // Invalidate any list caches that might contain this object
        // Similar logic as in putObject
        const keyParts = key.split('/');
        if (keyParts.length > 1) {
            let currentPath = '';
            for (let i = 0; i < keyParts.length - 1; i++) {
                if (i > 0) currentPath += '/';
                currentPath += keyParts[i];
                await removeFromCache(`__list__:${currentPath}`, env);
                await removeFromCache(`__list__:${currentPath}/`, env);
            }
            await removeFromCache('__list__:', env);
        } else {
            await removeFromCache('__list__:', env);
        }
    } catch (error) {
        console.error(`Error deleting object ${key}:`, error);
        throw error; // Rethrow to maintain the same error behavior as R2
    }
};

/**
 * List objects from R2 with a given prefix, using cache when available
 * 
 * @param prefix The key prefix to list
 * @param env The environment with R2 access
 * @param ttl Cache TTL in seconds (default: 5 minutes since listings change often)
 * @returns The list result from R2
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

        // If not in cache, get from R2
        const listing = await env.R2.list({ prefix });
        
        // Store in cache for future requests with a shorter TTL
        await setInCache(cacheKey, listing, env, ttl);
        
        return listing;
    } catch (error) {
        console.error(`Error listing objects with prefix ${prefix}:`, error);
        throw error; // Rethrow to maintain the same error behavior as R2
    }
};