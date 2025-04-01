"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const itty_router_1 = require("itty-router");
const itty_router_extras_1 = require("itty-router-extras");
const sessionManager_1 = require("../utils/sessionManager");
const userService_1 = require("../services/userService");
exports.router = (0, itty_router_1.AutoRouter)({ base: '/auth' });
async function verify(token) {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    if (!response.ok) {
        throw new Error('Invalid token');
    }
    const payload = await response.json();
    return payload;
}
exports.router.post('/loginGoogleToken', async (request, env) => {
    console.log('POST /auth/loginGoogleToken called');
    const body = await request.json();
    const { token } = body;
    if (!token) {
        return (0, itty_router_extras_1.json)({ error: 'Token is required' }, { status: 400 });
    }
    try {
        const payload = await verify(token);
        const { email, name, sub } = payload; // Extract email, name, and user ID (sub)
        // Create a session for the user
        const sessionId = await (0, sessionManager_1.CreateSession)(sub, { email, name }, env);
        // const sessionId = await sessionManager.createSession(sub, { email, name });
        return (0, itty_router_extras_1.json)({
            message: 'Token verified',
            email,
            name,
            userId: sub,
            sessionId, // Return the session ID to the client
        });
    }
    catch (error) {
        console.error('Error verifying token:', error);
        return (0, itty_router_extras_1.json)({ error: 'Invalid token' }, { status: 401 });
    }
});
exports.router.get('/session', async (request, env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!sessionId) {
        return (0, itty_router_extras_1.json)({ error: 'Session ID is required' }, { status: 400 });
    }
    const session = await (0, sessionManager_1.GetSession)(sessionId, env);
    if (!session) {
        return (0, itty_router_extras_1.json)({ error: 'Session not found or expired' }, { status: 404 });
    }
    return (0, itty_router_extras_1.json)({ message: 'Session retrieved', session });
});
exports.router.post('/logout', async (request, env) => {
    const sessionId = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!sessionId) {
        return (0, itty_router_extras_1.json)({ error: 'Session ID is required' }, { status: 400 });
    }
    await (0, sessionManager_1.DeleteSession)(sessionId, env);
    return (0, itty_router_extras_1.json)({ message: 'Logged out successfully' });
});
exports.router.post('/approve', async (request) => {
    const body = await request.json();
    const { userId } = body;
    if (!userId) {
        return (0, itty_router_extras_1.json)({ error: 'User ID is required' }, { status: 400 });
    }
    // Simulate user approval
    const approvedUser = (0, userService_1.approveUser)(userId);
    return (0, itty_router_extras_1.json)({ message: 'User approved', user: approvedUser });
});
