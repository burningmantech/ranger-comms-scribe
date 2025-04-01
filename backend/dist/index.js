"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.corsify = exports.preflight = void 0;
const itty_router_extras_1 = require("itty-router-extras");
const auth_1 = require("./handlers/auth");
const blog_1 = require("./handlers/blog");
const gallery_1 = require("./handlers/gallery");
const itty_router_1 = require("itty-router");
_a = (0, itty_router_1.cors)({
    // origin: 'https://dancingcats.org',
    origin: '*',
    allowMethods: '*',
    maxAge: 84600,
}), exports.preflight = _a.preflight, exports.corsify = _a.corsify;
const router = (0, itty_router_1.AutoRouter)({
    before: [exports.preflight],
    finally: [exports.corsify]
});
router
    .get('/', () => new Response('API is running'))
    .all('/auth/*', auth_1.router.fetch) // Handle all auth routes
    .all('/blog/*', blog_1.router.fetch) // Handle all blog routes
    .all('/gallery/*', gallery_1.router.fetch) // Handle all gallery routes
    .get('/foo', () => (0, exports.corsify)((0, itty_router_extras_1.json)({ message: 'Hello from foo!' }))); // Example route
exports.default = router;
