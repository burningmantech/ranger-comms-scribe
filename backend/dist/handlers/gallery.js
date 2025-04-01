"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const itty_router_1 = require("itty-router");
const mediaService_1 = require("../services/mediaService");
exports.router = (0, itty_router_1.AutoRouter)({ base: '/gallery' });
// Handler to get media content
exports.router.get('/', async () => {
    try {
        console.log('GET /gallery called');
        const media = await (0, mediaService_1.getMedia)();
        return new Response(JSON.stringify(media), {
            headers: { 'Content-Type': 'application/json' },
        });
    }
    catch (error) {
        console.error('Error fetching media:', error);
        return new Response('Error fetching media', { status: 500 });
    }
});
// Handler to upload media content
exports.router.post('/upload', async (request) => {
    try {
        console.log('POST /gallery/upload called');
        const formData = await request.formData();
        const mediaFile = formData.get('file');
        if (!(mediaFile instanceof File)) {
            console.error('Invalid file uploaded');
            return new Response('Invalid file uploaded', { status: 400 });
        }
        const result = await (0, mediaService_1.uploadMedia)(mediaFile);
        return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
        });
    }
    catch (error) {
        console.error('Error uploading media:', error);
        return new Response('Error uploading media', { status: 500 });
    }
});
// Fallback route for unmatched requests
exports.router.all('*', () => {
    console.error('No matching route found');
    return new Response('Route not found', { status: 404 });
});
