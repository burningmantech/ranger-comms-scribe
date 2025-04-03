export interface Env {
    R2: R2Bucket;
    PUBLIC_URL?: string;
}

export async function CreateSession(
        userId: string, 
        data: Record<string, any>, 
        env: Env,
        ttl: number = 864000 // Default TTL of 10 days in seconds
    ): Promise<string> {
    const sessionId = crypto.randomUUID(); // Generate a unique session ID
    const sessionData = {
        userId,
        data,
        expiresAt: Date.now() + ttl * 1000, // Expiration time in milliseconds
    };

    await env.R2.put(sessionId, JSON.stringify(sessionData), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { userId },
});

return sessionId;
}

export async function GetSession(
    sessionId: string, env: Env): Promise<Record<string, any> | null> {
    const object = await env.R2.get(sessionId);
    if (!object) return null;

    const sessionData = await object.json() as { userId: string; data: Record<string, any>; expiresAt: number };
    if (sessionData.expiresAt < Date.now()) {
        await DeleteSession(sessionId, env); // Delete expired session
        return null;
    }

    return sessionData;
}

export async function DeleteSession(sessionId: string, env: Env): Promise<void> {
    await env.R2.delete(sessionId);
}
