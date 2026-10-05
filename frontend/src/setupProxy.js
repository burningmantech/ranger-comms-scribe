// Development-server proxy (picked up automatically by react-scripts; not part of
// the production build).
//
// The backend stores media URLs relative to the site origin
// (/api/gallery/<file>[/thumbnail|/medium]) so saved content survives hostname
// changes. In AWS the SPA and API share one origin, so those URLs just work. In
// local development the SPA runs on :3000 and the API on another port
// (REACT_APP_API_URL, e.g. http://localhost:8080/api), so <img src="/api/gallery/...">
// would hit the dev server. This forwards those requests to the local backend.
//
// http-proxy-middleware ships with react-scripts (via webpack-dev-server).

module.exports = function setupProxy(app) {
  const apiUrl = process.env.REACT_APP_API_URL;
  if (!apiUrl) return;

  let target;
  try {
    const url = new URL(apiUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
    target = url.origin;
  } catch (e) {
    return;
  }

  let createProxyMiddleware;
  try {
    ({ createProxyMiddleware } = require('http-proxy-middleware'));
  } catch (e) {
    console.warn('setupProxy: http-proxy-middleware not found; relative /api/gallery URLs will not load in dev.');
    return;
  }

  app.use(createProxyMiddleware('/api/gallery', { target, changeOrigin: true }));
};
