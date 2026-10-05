import http from 'http';
import { AddressInfo } from 'net';
import { createAppServer, AppServer } from '../../src/httpServer';
import { configureCors } from '../../src/index';
import { loadConfig } from '../../src/config/env';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

// The ALB idle timeout is 120 s (infra/lib/scribe-service.ts). The server must keep
// idle connections at least that long or the ALB reuses closed ones (502s).
const ALB_IDLE_TIMEOUT_MS = 120_000;

const BASE_ENV = {
  PUBLIC_URL: 'http://localhost/api',
  FRONTEND_URL: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: 'c',
  TURNSTILESECRET: 's',
  STORE_DRIVER: 'memory',
};

function testEnv() {
  return loadConfig(BASE_ENV, { store: new MemoryObjectStore() }).env;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Send a request with `http.request` so the test controls Content-Length and chunking
 * (fetch would compute them itself). `chunks` are written one by one; with no
 * `contentLength` Node sends them chunked.
 */
function rawRequest(
  port: number,
  path: string,
  opts: { method?: string; contentLength?: number; chunks?: string[] } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { 'Content-Type': 'application/json' };
    if (opts.contentLength !== undefined) headers['Content-Length'] = opts.contentLength;
    const req = http.request(
      { host: '127.0.0.1', port, path, method: opts.method || 'POST', headers, agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
        res.on('error', reject);
      }
    );
    // The server may close the connection after answering 413 while we're still writing.
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') reject(error);
    });
    for (const chunk of opts.chunks || []) req.write(chunk);
    req.end();
  });
}

describe('createAppServer', () => {
  it('keeps idle connections open longer than the ALB idle timeout', async () => {
    const app = createAppServer(testEnv());
    expect(app.server.keepAliveTimeout).toBeGreaterThan(ALB_IDLE_TIMEOUT_MS);
    expect(app.server.headersTimeout).toBeGreaterThan(app.server.keepAliveTimeout);
    await app.close();
  });
});

describe('request body size limit', () => {
  const LIMIT = 1024;
  let app: AppServer;
  let port: number;

  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const env = testEnv();
    configureCors(env.CORS_ORIGINS);
    app = createAppServer(env, { maxBodyBytes: LIMIT });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
    ({ port } = app.server.address() as AddressInfo);
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('defaults MAX_BODY_BYTES to 25 MiB and reads overrides', () => {
    expect(loadConfig(BASE_ENV).maxBodyBytes).toBe(25 * 1024 * 1024);
    expect(loadConfig({ ...BASE_ENV, MAX_BODY_BYTES: '2048' }).maxBodyBytes).toBe(2048);
    expect(() => loadConfig({ ...BASE_ENV, MAX_BODY_BYTES: '-1' })).toThrow('Invalid MAX_BODY_BYTES');
    expect(() => loadConfig({ ...BASE_ENV, MAX_BODY_BYTES: 'lots' })).toThrow('Invalid MAX_BODY_BYTES');
  });

  it('answers 413 from an oversized Content-Length without waiting for the body', async () => {
    // Declares 4 KiB but sends only a few bytes: the decision must come from the header.
    const res = await rawRequest(port, '/api/auth/verify-email', { contentLength: 4 * LIMIT, chunks: ['{"tok'] });
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe('close');
    expect(JSON.parse(res.body)).toEqual({ error: 'Request body too large', maxBytes: LIMIT });
  });

  it('answers 413 when a chunked body passes the limit', async () => {
    const chunk = 'x'.repeat(400);
    const res = await rawRequest(port, '/api/auth/verify-email', { chunks: [chunk, chunk, chunk, chunk] });
    expect(res.status).toBe(413);
  });

  it('still handles a normal POST with Content-Length', async () => {
    const body = JSON.stringify({ token: 'nope' });
    const res = await rawRequest(port, '/api/auth/verify-email', { contentLength: Buffer.byteLength(body), chunks: [body] });
    // The handler parsed the body: an unknown token, not "token is required".
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid or expired verification token' });
  });

  it('still handles a chunked POST within the limit', async () => {
    const res = await rawRequest(port, '/api/auth/verify-email', { chunks: ['{"token":', '"nope"}'] });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid or expired verification token' });

    const empty = await rawRequest(port, '/api/auth/verify-email', { chunks: ['{}'] });
    expect(JSON.parse(empty.body)).toEqual({ error: 'Verification token is required' });
  });

  it('serves GET requests and /healthz as before', async () => {
    const res = await rawRequest(port, '/healthz', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});
