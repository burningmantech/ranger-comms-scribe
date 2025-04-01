"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeleteSession = exports.GetSession = exports.CreateSession = void 0;
async function CreateSession(userId, data, env, ttl = 3600) {
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
exports.CreateSession = CreateSession;
async function GetSession(sessionId, env) {
    const object = await env.R2.get(sessionId);
    if (!object)
        return null;
    const sessionData = await object.json();
    if (sessionData.expiresAt < Date.now()) {
        await DeleteSession(sessionId, env); // Delete expired session
        return null;
    }
    return sessionData;
}
exports.GetSession = GetSession;
async function DeleteSession(sessionId, env) {
    await env.R2.delete(sessionId);
}
exports.DeleteSession = DeleteSession;
