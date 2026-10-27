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
    /** A sent announcement can be sent again (dev, for testing email rendering). */
    ALLOW_ANNOUNCEMENT_RESEND?: boolean;
    /** Comms Calendar nudges all go here instead of to the team contacts (dev and staging). */
    NUDGE_EMAIL_OVERRIDE?: string;
    /** Sends to mailing lists and approval reminders all go here instead (dev); see utils/email.ts commsRecipients. */
    COMMS_EMAIL_OVERRIDE?: string;
    /** "off" turns the daily reminder digest off (REMINDER_DIGEST); anything else leaves it on. */
    REMINDER_DIGEST?: string;
    /** Emails (lowercased) that are promoted to Admin on register/login. */
    BOOTSTRAP_ADMIN_EMAILS?: string[];
    /**
     * Real-time editing mode served to the frontend by GET /api/config (COLLAB_MODE):
     * 'yjs' (merged editing over /api/ws/yjs/submissions/:id) or 'legacy' (whole-document sync).
     */
    COLLAB_MODE?: CollabMode;
}

export type CollabMode = 'yjs' | 'legacy';

/**
 * Sessions live at `session/<id>`. Each also has an empty marker at
 * `session-index/<lowercased userId>/<id>`, so a person's sessions are found by listing their
 * own prefix (DeleteSessionsForUser) instead of reading every session. The startup migration
 * `migrations/sessionIndex.ts` indexed the sessions made before the index existed.
 */
export const SESSION_INDEX_PREFIX = 'session-index/';
export const sessionIndexKey = (userId: string, sessionId: string): string =>
    `${SESSION_INDEX_PREFIX}${userId.trim().toLowerCase()}/${sessionId}`;

/**
 * Told the IDs of sessions that just ended (sign-out, expiry, a password reset, a deleted
 * account), so open WebSockets made with them can be closed (handlers/websocket.ts).
 */
type SessionsEndedListener = (sessionIds: string[]) => void;
const sessionsEndedListeners: SessionsEndedListener[] = [];
export function onSessionsEnded(listener: SessionsEndedListener): void {
    sessionsEndedListeners.push(listener);
}
function notifySessionsEnded(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    for (const listener of sessionsEndedListeners) {
        try {
            listener(sessionIds);
        } catch (error) {
            console.error('Error closing connections for ended sessions:', error);
        }
    }
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

    await env.STORE.put(`session/${sessionId}`, JSON.stringify(sessionData), {
        contentType: 'application/json',
        metadata: { userId },
    });
    await env.STORE.put(sessionIndexKey(userId, sessionId), '{}', { contentType: 'application/json' });

return sessionId;
}

export async function GetSession(
    sessionId: string, env: Env): Promise<Record<string, any> | null> {
    const object = await env.STORE.get(`session/${sessionId}`);
    if (!object) return null;

    const sessionData = await object.json() as { userId: string; data: Record<string, any>; expiresAt: number };
    if (sessionData.expiresAt < Date.now()) {
        await DeleteSession(sessionId, env, sessionData.userId); // Delete expired session
        return null;
    }

    return sessionData;
}

/** End one session (sign-out, expiry). `userId` saves reading the session for its index entry. */
export async function DeleteSession(sessionId: string, env: Env, userId?: string): Promise<void> {
    let owner = userId;
    if (!owner) {
        try {
            const object = await env.STORE.get(`session/${sessionId}`);
            owner = object ? ((await object.json()) as { userId?: string }).userId : undefined;
        } catch {
            owner = undefined; // unreadable: the index entry (if any) is left behind, harmlessly
        }
    }
    await env.STORE.delete(`session/${sessionId}`);
    if (owner) await env.STORE.delete(sessionIndexKey(owner, sessionId));
    notifySessionsEnded([sessionId]);
}

/**
 * Delete every session belonging to `userId` (the email sessions are created with), found
 * through the session index. Used when an account changes hands in effect (a password reset,
 * a bootstrap admin's promotion, a Google sign-in over an unproven password) or is deleted.
 * Returns how many were deleted.
 */
export async function DeleteSessionsForUser(userId: string, env: Env): Promise<number> {
    const prefix = `${SESSION_INDEX_PREFIX}${userId.trim().toLowerCase()}/`;
    const { objects } = await env.STORE.list(prefix);
    const sessionIds = objects.map(({ key }) => key.slice(prefix.length)).filter(Boolean);
    await Promise.all(sessionIds.map(async (sessionId) => {
        await env.STORE.delete(`session/${sessionId}`);
        await env.STORE.delete(`${prefix}${sessionId}`);
    }));
    notifySessionsEnded(sessionIds);
    return sessionIds.length;
}
