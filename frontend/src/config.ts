export const GOOGLE_CLIENT_ID = ''; // TODO: Add one

// Use environment variable for API_URL if available (for local development)
export const API_URL = process.env.REACT_APP_API_URL || 'https://api.scrivenly.com';

// Environment settings
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DEBUG_LOGGING_ENABLED = !IS_PRODUCTION;
