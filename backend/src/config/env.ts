import { CollabMode, Env } from '../utils/sessionManager';
import { ObjectStore } from '../storage/objectStore';
import { S3ObjectStore } from '../storage/s3ObjectStore';
import { MemoryObjectStore } from '../storage/memoryObjectStore';
import { LatencyObjectStore } from '../storage/latencyObjectStore';

/**
 * Builds the runtime `Env` from process environment variables.
 *
 * Variables (see docs/plans/2026-10-04-aws-migration-contracts.md, section 3):
 *   PORT                    default 8080
 *   PUBLIC_URL              required, e.g. https://app.scrivenly.com/api
 *   FRONTEND_URL            required, e.g. https://app.scrivenly.com
 *   CORS_ORIGINS            CSV; default FRONTEND_URL plus http://localhost:3000
 *   DATA_BUCKET             required unless STORE_DRIVER=memory
 *   S3_ENDPOINT             optional, e.g. http://localhost:9000 for MinIO (path-style)
 *   AWS_REGION              default us-east-1 (S3 client)
 *   SES_REGION              default us-east-1
 *   EMAIL_FROM              default "Comms Scribe <alex@scrivenly.com>"
 *   EMAIL_BCC               CSV; default empty (no BCC)
 *   ANNOUNCE_EMAIL_TO       recipient for approved-submission announcements; unset disables sending
 *   ALLOW_ANNOUNCEMENT_RESEND "true" lets a sent announcement be sent again (dev only)
 *   NUDGE_EMAIL_OVERRIDE    Comms Calendar nudges go only to this address (dev and staging)
 *   BOOTSTRAP_ADMIN_EMAILS  CSV, case-insensitive
 *   GOOGLE_CLIENT_ID        required
 *   TURNSTILESECRET         required
 *   DEV_BYPASS_AUTH         "true" enables fake users (local only)
 *   MAX_BODY_BYTES          largest accepted HTTP request body; default 25 MiB (larger: 413)
 *   WS_MAX_PAYLOAD_BYTES    largest accepted WebSocket message; default 16 MiB (larger: close 1009)
 *   COLLAB_MODE             "yjs" or "legacy" (default): real-time editing mode, served by GET /api/config
 *
 * Local/test only:
 *   STORE_DRIVER            "memory" uses an in-process MemoryObjectStore instead of S3.
 *                           Data is lost on restart. Default "s3".
 *   STORE_LATENCY_MS        with STORE_DRIVER=memory: delay every store call by a random
 *                           0..N ms, like S3 round trips (exposes races the instant in-memory
 *                           store hides). Ignored for S3. Default 0.
 *
 * AWS credentials always come from the default credential chain.
 */

export const DEFAULT_PORT = 8080;
export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_EMAIL_FROM = 'Comms Scribe <alex@scrivenly.com>';

const MIB = 1024 * 1024;
/**
 * Gallery uploads carry up to three files in one multipart request (original,
 * thumbnail and medium), so this is well above the largest single image.
 */
export const DEFAULT_MAX_BODY_BYTES = 25 * MIB;
/**
 * Whole-document `realtime_content_update` messages carry the full Lexical JSON;
 * images are uploaded separately and referenced by URL. (`ws` defaults to 100 MiB.)
 */
export const DEFAULT_WS_MAX_PAYLOAD_BYTES = 16 * MIB;

const REQUIRED = ['PUBLIC_URL', 'FRONTEND_URL', 'GOOGLE_CLIENT_ID', 'TURNSTILESECRET'] as const;

export interface LoadedConfig {
  port: number;
  storeDriver: 'memory' | 's3';
  /** MAX_BODY_BYTES: requests with a larger body get 413. */
  maxBodyBytes: number;
  /** WS_MAX_PAYLOAD_BYTES: a larger WebSocket message closes the socket (1009). */
  wsMaxPayloadBytes: number;
  env: Env;
}

type Source = Record<string, string | undefined>;

/** Split a comma-separated value into trimmed, non-empty entries. */
export function parseCsv(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parsePort(value: string | undefined): number {
  const raw = nonEmpty(value);
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

/** A positive whole number of bytes, or `fallback` when unset/blank. */
export function parseByteLimit(name: string, value: string | undefined, fallback: number): number {
  const raw = nonEmpty(value);
  if (!raw) return fallback;
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`Invalid ${name}: ${value} (expected a positive number of bytes)`);
  }
  return bytes;
}

/** COLLAB_MODE: "yjs" or "legacy" (default when unset/blank). Anything else is a startup error. */
export function parseCollabMode(value: string | undefined): CollabMode {
  const raw = nonEmpty(value);
  if (!raw) return 'legacy';
  const mode = raw.toLowerCase();
  if (mode !== 'yjs' && mode !== 'legacy') {
    throw new Error(`Invalid COLLAB_MODE: ${value} (expected "yjs" or "legacy")`);
  }
  return mode;
}

/**
 * Build the Env from `source` (defaults to process.env). Throws one error listing
 * every missing required variable.
 *
 * `store` lets tests inject an ObjectStore; otherwise STORE_DRIVER decides.
 */
export function loadConfig(source: Source = process.env, options: { store?: ObjectStore } = {}): LoadedConfig {
  const storeDriver = (nonEmpty(source.STORE_DRIVER) || 's3').toLowerCase();
  if (storeDriver !== 'memory' && storeDriver !== 's3') {
    throw new Error(`Invalid STORE_DRIVER: ${source.STORE_DRIVER} (expected "s3" or "memory")`);
  }

  const missing: string[] = REQUIRED.filter((name) => !nonEmpty(source[name]));
  if (storeDriver === 's3' && !options.store && !nonEmpty(source.DATA_BUCKET)) {
    missing.push('DATA_BUCKET');
  }
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const collabMode = parseCollabMode(source.COLLAB_MODE);
  const frontendUrl = nonEmpty(source.FRONTEND_URL)!;
  const corsOrigins = parseCsv(source.CORS_ORIGINS);

  let store: ObjectStore;
  if (options.store) {
    store = options.store;
  } else if (storeDriver === 'memory') {
    const latencyMs = Number(nonEmpty(source.STORE_LATENCY_MS) || 0);
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
      throw new Error(`Invalid STORE_LATENCY_MS: ${source.STORE_LATENCY_MS} (expected a number of milliseconds)`);
    }
    store = latencyMs > 0 ? new LatencyObjectStore(new MemoryObjectStore(), latencyMs) : new MemoryObjectStore();
  } else {
    store = new S3ObjectStore({
      bucket: nonEmpty(source.DATA_BUCKET)!,
      region: nonEmpty(source.AWS_REGION) || DEFAULT_REGION,
      endpoint: nonEmpty(source.S3_ENDPOINT),
    });
  }

  const env: Env = {
    STORE: store,
    PUBLIC_URL: nonEmpty(source.PUBLIC_URL),
    FRONTEND_URL: frontendUrl,
    GOOGLE_CLIENT_ID: nonEmpty(source.GOOGLE_CLIENT_ID),
    TURNSTILESECRET: nonEmpty(source.TURNSTILESECRET),
    DEV_BYPASS_AUTH: nonEmpty(source.DEV_BYPASS_AUTH),
    CORS_ORIGINS: corsOrigins.length > 0 ? corsOrigins : [frontendUrl, 'http://localhost:3000'],
    SES_REGION: nonEmpty(source.SES_REGION) || DEFAULT_REGION,
    EMAIL_FROM: nonEmpty(source.EMAIL_FROM) || DEFAULT_EMAIL_FROM,
    EMAIL_BCC: parseCsv(source.EMAIL_BCC),
    ANNOUNCE_EMAIL_TO: nonEmpty(source.ANNOUNCE_EMAIL_TO),
    ALLOW_ANNOUNCEMENT_RESEND: source.ALLOW_ANNOUNCEMENT_RESEND === 'true',
    NUDGE_EMAIL_OVERRIDE: nonEmpty(source.NUDGE_EMAIL_OVERRIDE),
    BOOTSTRAP_ADMIN_EMAILS: parseCsv(source.BOOTSTRAP_ADMIN_EMAILS).map((email) => email.toLowerCase()),
    COLLAB_MODE: collabMode,
  };

  return {
    port: parsePort(source.PORT),
    storeDriver: storeDriver as 'memory' | 's3',
    maxBodyBytes: parseByteLimit('MAX_BODY_BYTES', source.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    wsMaxPayloadBytes: parseByteLimit('WS_MAX_PAYLOAD_BYTES', source.WS_MAX_PAYLOAD_BYTES, DEFAULT_WS_MAX_PAYLOAD_BYTES),
    env,
  };
}
