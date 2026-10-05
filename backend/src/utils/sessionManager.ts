import { ObjectStore } from '../storage/objectStore';

/**
 * Runtime environment passed to every handler as the second argument.
 * Built once at boot from process.env by `src/config/env.ts` (see the
 * contracts doc, section 3, for the variable list).
 */
export interface Env {
    STORE: ObjectStore;
    PUBLIC_URL?: string;
    FRONTEND_URL?: string;
    GOOGLE_CLIENT_ID?: string; // OAuth client ID that Google ID tokens must be issued to
    TURNSTILESECRET?: string;
    DEV_BYPASS_AUTH?: string;
    /** Allowed CORS origins (parsed from the CORS_ORIGINS CSV). */
    CORS_ORIGINS?: string[];
    /** SES v2 region (default us-east-1). */
    SES_REGION?: string;
    /** From address for outgoing email. */
    EMAIL_FROM?: string;
    /** BCC recipients for outgoing email; empty means no BCC. */
    EMAIL_BCC?: string[];
    /** Recipient for approved-submission announcements; unset means announcements can't be sent. */
    ANNOUNCE_EMAIL_TO?: string;
    /** Emails (lowercased) that are promoted to Admin on register/login. */
    BOOTSTRAP_ADMIN_EMAILS?: string[];
    /**
     * Real-time editing mode served to the frontend by GET /api/config (COLLAB_MODE):
     * 'yjs' (merged editing over /api/ws/yjs/submissions/:id) or 'legacy' (whole-document sync).
     */
    COLLAB_MODE?: CollabMode;
}

export type CollabMode = 'yjs' | 'legacy';

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

    await env.STORE.put(`session/${sessionId}`, JSON.stringify(sessionData), {
        contentType: 'application/json',
        metadata: { userId },
    });

return sessionId;
}

export async function GetSession(
    sessionId: string, env: Env): Promise<Record<string, any> | null> {
    const object = await env.STORE.get(`session/${sessionId}`);
    if (!object) return null;

    const sessionData = await object.json() as { userId: string; data: Record<string, any>; expiresAt: number };
    if (sessionData.expiresAt < Date.now()) {
        await DeleteSession(sessionId, env); // Delete expired session
        return null;
    }

    return sessionData;
}

export async function DeleteSession(sessionId: string, env: Env): Promise<void> {
    await env.STORE.delete(`session/${sessionId}`);
}

/**
 * Delete every session belonging to `userId` (the email sessions are created with).
 * Used when an account changes hands in effect: e.g. a bootstrap admin is promoted
 * on an account someone else may have registered first, whose sessions resolve to
 * the (now promoted) user record. Rare, so a full scan of session/ is acceptable.
 */
export async function DeleteSessionsForUser(userId: string, env: Env): Promise<number> {
    const target = userId.trim().toLowerCase();
    const { objects } = await env.STORE.list('session/');
    let deleted = 0;
    for (const { key } of objects) {
        const object = await env.STORE.get(key);
        if (!object) continue;
        try {
            const session = await object.json() as { userId?: string };
            if (session.userId && session.userId.trim().toLowerCase() === target) {
                await env.STORE.delete(key);
                deleted += 1;
            }
        } catch {
            // Unreadable session object; leave it to expire.
        }
    }
    return deleted;
}
