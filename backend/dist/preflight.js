"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.corsify = exports.preflight = void 0;
const itty_router_1 = require("itty-router");
_a = (0, itty_router_1.cors)({
    origin: ['https://dancingcats.org', 'https://www.dancingcats.org', 'http://localhost:3000'],
    allowMethods: '*',
    maxAge: 84600,
}), exports.preflight = _a.preflight, exports.corsify = _a.corsify;
