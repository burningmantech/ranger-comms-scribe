import http, { IncomingMessage, ServerResponse, STATUS_CODES } from 'http';
import type { Duplex } from 'stream';
import { createServerAdapter } from '@whatwg-node/server';
import { WebSocketServer } from 'ws';
import { router } from './index';
import { Env } from './utils/sessionManager';
import { DEFAULT_MAX_BODY_BYTES } from './config/env';
import { authorizeRoomConnection } from './handlers/websocket';
import { RoomTarget, closeAllRooms, joinRoom } from './realtime/rooms';

const WS_PATH = /^\/api\/ws\/(submissions|documents)\/([^/]+)\/?$/;

// Keep idle connections open longer than the ALB idle timeout (120 s,
// infra/lib/scribe-service.ts). With Node's 5 s default the server closes
// connections the ALB still considers reusable, giving sporadic 502s.
export const KEEP_ALIVE_TIMEOUT_MS = 125_000;

/** Execution context handed to handlers as the third argument (Worker-style). */
const executionContext = {
  waitUntil(promise: Promise<unknown>) {
    Promise.resolve(promise).catch((error) => console.error('Background task failed:', error));
  },
  passThroughOnException() {},
};

function rejectUpgrade(socket: Duplex, status: number, body: Record<string, unknown>): void {
  if (socket.destroyed) return;
  const payload = JSON.stringify(body);
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] || 'Error'}\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
    'Connection: close\r\n' +
    '\r\n' +
    payload
  );
  socket.destroy();
}

function rejectTooLarge(res: ServerResponse, maxBodyBytes: number): void {
  if (res.headersSent || res.destroyed) return;
  const payload = JSON.stringify({ error: 'Request body too large', maxBytes: maxBodyBytes });
  // Connection: close, so Node closes the socket once the response is out instead
  // of waiting for (or reading) the rest of an oversized body.
  res.writeHead(413, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Connection': 'close',
  });
  res.end(payload);
}

/**
 * Read a request body that has no Content-Length (chunked), up to `limit` bytes.
 * Resolves with the body, or `null` as soon as it passes the limit (reading stops;
 * the caller answers 413).
 */
function readBodyWithin(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        cleanup();
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Request closed before the body was read'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

export interface AppServerOptions {
  /** Largest accepted request body (MAX_BODY_BYTES); larger requests get 413. Default 25 MiB. */
  maxBodyBytes?: number;
}

export interface AppServer {
  server: http.Server;
  /** Close all WebSocket rooms and stop the HTTP server. */
  close(): Promise<void>;
}

/**
 * Build the HTTP server: REST through the itty-router app (via @whatwg-node/server)
 * and WebSocket upgrades for /api/ws/{submissions,documents}/:id via `ws`.
 * The caller decides when to listen.
 */
export function createAppServer(env: Env, options: AppServerOptions = {}): AppServer {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  // itty's fetch takes (request, ...args) and passes the args to handlers, so
  // handlers keep their (request, env, ctx) signature.
  const adapter = createServerAdapter((request: Request) => router.fetch(request, env, executionContext));

  // Handlers buffer whole bodies (request.json(), formData()), so cap the size
  // before the router sees the request.
  //  - With Content-Length: decided from the header. Node's parser never delivers
  //    more bytes than the header declares, so the adapter can stream the body as usual.
  //  - Chunked (no Content-Length): read it here, within the limit, and hand the
  //    adapter the buffered body (`req.body`, which @whatwg-node/server uses in
  //    place of the stream when present).
  const server = http.createServer((req, res) => {
    const contentLength = req.headers['content-length'];
    if (contentLength !== undefined) {
      if (Number(contentLength) > maxBodyBytes) {
        rejectTooLarge(res, maxBodyBytes);
        return;
      }
      void adapter(req, res);
      return;
    }
    if (req.headers['transfer-encoding'] === undefined) {
      void adapter(req, res); // no body
      return;
    }
    readBodyWithin(req, maxBodyBytes).then(
      (body) => {
        if (body === null) {
          rejectTooLarge(res, maxBodyBytes);
          return;
        }
        if (body.length > 0) {
          (req as IncomingMessage & { body?: Buffer }).body = body;
        }
        void adapter(req, res);
      },
      (error) => {
        console.error('Error reading request body:', error);
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Connection': 'close' });
          res.end(JSON.stringify({ error: 'Bad request' }));
        }
      }
    );
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000; // must exceed keepAliveTimeout
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', (error) => console.error('Upgrade socket error:', error));

    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url || '/', 'http://localhost');
      } catch {
        rejectUpgrade(socket, 400, { error: 'Bad request' });
        return;
      }

      const match = WS_PATH.exec(url.pathname);
      if (!match) {
        rejectUpgrade(socket, 404, { error: 'Not Found' });
        return;
      }

      let id: string;
      try {
        id = decodeURIComponent(match[2]);
      } catch {
        rejectUpgrade(socket, 400, { error: 'Bad request' });
        return;
      }
      const target: RoomTarget = { kind: match[1] === 'submissions' ? 'submission' : 'document', id };

      try {
        const result = await authorizeRoomConnection(
          target,
          { sessionId: url.searchParams.get('sessionId'), testUser: url.searchParams.get('testUser') },
          env
        );
        if (!result.ok) {
          rejectUpgrade(socket, result.status, result.body);
          return;
        }
        if (socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => joinRoom(ws, target, result.identity));
      } catch (error) {
        console.error('Error handling WebSocket upgrade:', error);
        rejectUpgrade(socket, 500, { error: 'Failed to connect to WebSocket service' });
      }
    })();
  });

  return {
    server,
    close: () => new Promise<void>((resolve) => {
      closeAllRooms(1001, 'Server shutting down');
      wss.close();
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      // Drop idle keep-alive connections so close() doesn't wait for them.
      server.closeIdleConnections?.();
    }),
  };
}
