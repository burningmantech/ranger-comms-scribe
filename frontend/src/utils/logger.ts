/**
 * Utility for conditional logging that can be disabled in production.
 * This allows us to keep debug statements in the code but silence them in production builds.
 */

// Determine if we're in production mode
// In a React app built with Create React App, NODE_ENV is automatically set
// If using a different build system, this might need to be adjusted
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Logger utility that conditionally logs based on environment
 */
export const logger = {
  /**
   * Debug log - only appears in development mode
   */
  debug: (...args: any[]): void => {
    if (!isProduction) {
      console.log('[DEBUG]', ...args);
    }
  },

  /**
   * Info log - appears in all environments
   */
  info: (...args: any[]): void => {
    console.info('[INFO]', ...args);
  },

  /**
   * Warning log - appears in all environments
   */
  warn: (...args: any[]): void => {
    console.warn('[WARNING]', ...args);
  },

  /**
   * Error log - appears in all environments
   */
  error: (...args: any[]): void => {
    console.error('[ERROR]', ...args);
  }
};

export default logger;