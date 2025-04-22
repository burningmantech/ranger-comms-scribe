export const GOOGLE_CLIENT_ID = '506064022717-4f6o2i9v8560g5g3ns45h1al3sr2p8j0.apps.googleusercontent.com';

// Use environment variable for API_URL if available (for local development)
export const API_URL = process.env.REACT_APP_API_URL || 'https://api.dancingcats.org';

// Environment settings
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DEBUG_LOGGING_ENABLED = !IS_PRODUCTION;
