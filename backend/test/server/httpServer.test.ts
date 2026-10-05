import { createAppServer } from '../../src/httpServer';
import { loadConfig } from '../../src/config/env';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

// The ALB idle timeout is 120 s (infra/lib/scribe-service.ts). The server must keep
// idle connections at least that long or the ALB reuses closed ones (502s).
const ALB_IDLE_TIMEOUT_MS = 120_000;

describe('createAppServer', () => {
  it('keeps idle connections open longer than the ALB idle timeout', async () => {
    const { env } = loadConfig(
      {
        PUBLIC_URL: 'http://localhost/api',
        FRONTEND_URL: 'http://localhost:3000',
        GOOGLE_CLIENT_ID: 'c',
        TURNSTILESECRET: 's',
        STORE_DRIVER: 'memory',
      },
      { store: new MemoryObjectStore() }
    );
    const app = createAppServer(env);
    expect(app.server.keepAliveTimeout).toBeGreaterThan(ALB_IDLE_TIMEOUT_MS);
    expect(app.server.headersTimeout).toBeGreaterThan(app.server.keepAliveTimeout);
    await app.close();
  });
});
