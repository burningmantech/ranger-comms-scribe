import { KVNamespace } from '@cloudflare/workers-types';
import { ObjectStore } from '../storage/objectStore';

// Define more specific D1 types
interface D1PreparedStatement {
    bind(...values: any[]): D1PreparedStatement;
    first<T = any>(): Promise<T | null>;
    run<T = any>(): Promise<T>;
    all<T = any>(): Promise<T[]>;
    raw<T = any[]>(): Promise<T[]>;
}

// Define the D1Database interface for the D1 database
interface D1Database {
    prepare: (query: string) => D1PreparedStatement;
    exec: (query: string) => Promise<any>;
    batch: (statements: any[]) => Promise<any>;
    name?: string;
}

export interface Env {
    TURNSTILESECRET: any;
    STORE: ObjectStore;
    PUBLIC_URL?: string;
    FRONTEND_URL?: string;
    GOOGLE_CLIENT_ID?: string; // OAuth client ID that Google ID tokens must be issued to
    SESKey?: string;
    SESSecret?: string;
    TURSTILESECRET?: string; // Added Turnstile secret binding
    D1?: D1Database; // Add D1 database property
    DB: D1Database;
    EMAIL: any;
    SESSIONS: KVNamespace;
    USERS: KVNamespace;
    GROUPS: KVNamespace;
    ROLES: KVNamespace;
    DEV_BYPASS_AUTH?: string;
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
