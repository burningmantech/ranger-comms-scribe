/**
 * Node entry point: one process serving REST under /api/*, WebSocket upgrades
 * under /api/ws/*, and GET /healthz. Configuration comes from environment
 * variables (see src/config/env.ts).
 */
import { loadConfig } from './config/env';
import { configureCors, initializeApp } from './index';
import { createAppServer } from './httpServer';

async function main(): Promise<void> {
  const { env, port, storeDriver, maxBodyBytes } = loadConfig();
  configureCors(env.CORS_ORIGINS);

  if (env.DEV_BYPASS_AUTH === 'true') {
    console.warn('DEV_BYPASS_AUTH=true: authentication is bypassed. Never use this outside local development.');
  }

  // Startup work runs once here, never per request. A failure is logged but does
  // not stop the server, so /healthz stays up and the problem shows in the logs.
  try {
    await initializeApp(env);
    console.log('Application initialized');
  } catch (error) {
    console.error('Error initializing application:', error);
  }

  const app = createAppServer(env, { maxBodyBytes });
  app.server.listen(port, () => {
    console.log(`Comms Scribe backend listening on port ${port} (store: ${storeDriver})`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    const forceExit = setTimeout(() => process.exit(0), 8000);
    forceExit.unref();
    app.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
