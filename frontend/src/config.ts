export const GOOGLE_CLIENT_ID = '402914910938-47o6ff5rkig658lr4k51rmrmlbm4s4qg.apps.googleusercontent.com';

// Use environment variable for API_URL if available (for local development)
export const API_URL = process.env.REACT_APP_API_URL || 'https://scrivenly.com/api';

// WebSocket URL is derived from API_URL by the WebSocket service
export const WS_URL = API_URL.replace(/^https?:/, 'wss:');

// Environment settings
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DEBUG_LOGGING_ENABLED = !IS_PRODUCTION;
