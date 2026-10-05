export const GOOGLE_CLIENT_ID = '402914910938-47o6ff5rkig658lr4k51rmrmlbm4s4qg.apps.googleusercontent.com';

// API base URL. One build works in every environment because the SPA and API share an origin
// (<host>/ and <host>/api). Order:
//   1. REACT_APP_API_URL, if set (local development against a local backend);
//   2. on localhost without it, the production API (keeps today's `npm start` behaviour);
//   3. otherwise the current origin + '/api'.
// The WebSocket service derives its ws(s):// URL from this value.
function resolveApiUrl(): string {
  if (process.env.REACT_APP_API_URL) {
    return process.env.REACT_APP_API_URL;
  }
  if (window.location.hostname === 'localhost') {
    return 'https://scrivenly.com/api';
  }
  return `${window.location.origin}/api`;
}

export const API_URL = resolveApiUrl();

// Environment settings
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DEBUG_LOGGING_ENABLED = !IS_PRODUCTION;
