import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3';
import { ListResult, ObjectInfo, ObjectStore, PutOptions, StoredObject } from './objectStore';

export interface S3ObjectStoreOptions {
  bucket: string;
  region?: string;
  /** Custom endpoint, e.g. `http://localhost:9000` for MinIO. Forces path-style addressing. */
  endpoint?: string;
  /** Omit to use the default AWS credential chain. */
  credentials?: S3ClientConfig['credentials'];
}

/**
 * Every user-metadata key the backend writes. S3 lowercases user-metadata keys
 * (they travel as `x-amz-meta-*` headers), so we map them back to the camelCase
 * spelling the code reads. Unknown keys pass through unchanged.
 *
 * Keep this in sync with `metadata: {...}` / `customMetadata: {...}` writes in backend/src.
 * Note `isThumbail` is misspelled at its write site (mediaService.ts) and is kept as-is.
 */
export const KNOWN_METADATA_KEYS: readonly string[] = [
  'userId',
  'createdAt',
  'updatedAt',
  'isPublic',
  'groupId',
  'takenBy',
  'memberId',
  'originalName',
  'fileSize',
  'originalMediaKey',
  'isThumbail',
  'isThumbnail',
  'isMedium',
  'isResized',
  'type',
  'parentId',
  'level',
  'blockedBy',
  'blockedAt',
];

const KEY_BY_LOWERCASE: Record<string, string> = KNOWN_METADATA_KEYS.reduce((acc, key) => {
  acc[key.toLowerCase()] = key;
  return acc;
}, {} as Record<string, string>);

/**
 * Metadata values are sent as HTTP header values, which must be ASCII. Values such as
 * `originalName` (a raw filename) and `takenBy` (user input) can contain other characters,
 * so every value is percent-encoded on write and decoded on read.
 */
export function encodeMetadata(metadata?: Record<string, string>): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    out[key] = encodeURIComponent(String(value));
  }
  return out;
}

export function restoreMetadata(metadata?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!metadata) return out;
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    const key = KEY_BY_LOWERCASE[rawKey.toLowerCase()] ?? rawKey;
    let value = rawValue ?? '';
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not percent-encoded (e.g. written by another tool); keep the raw value.
    }
    out[key] = value;
  }
  return out;
}

function isNotFound(error: unknown): boolean {
  const err = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  if (!err) return false;
  return (
    err.name === 'NoSuchKey' ||
    err.name === 'NotFound' ||
    err.Code === 'NoSuchKey' ||
    err.$metadata?.httpStatusCode === 404
  );
}

function toBody(body: string | ArrayBuffer | Uint8Array): string | Uint8Array {
  if (typeof body === 'string' || body instanceof Uint8Array) {
    return body;
  }
  return new Uint8Array(body);
}

const decoder = new TextDecoder();

/** ObjectStore on Amazon S3 (or any S3-compatible service such as MinIO). */
export class S3ObjectStore implements ObjectStore {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    const config: S3ClientConfig = {
      region: options.region || 'us-east-1',
    };
    if (options.endpoint) {
      config.endpoint = options.endpoint;
      config.forcePathStyle = true;
    }
    if (options.credentials) {
      config.credentials = options.credentials;
    }
    this.client = new S3Client(config);
  }

  async get(key: string): Promise<StoredObject | null> {
    let output;
    try {
      output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    // Read the body exactly once and serve every accessor from the same bytes.
    const bytes: Uint8Array = output.Body ? await output.Body.transformToByteArray() : new Uint8Array(0);

    return {
      key,
      size: output.ContentLength ?? bytes.byteLength,
      uploaded: output.LastModified ?? new Date(0),
      etag: output.ETag,
      contentType: output.ContentType,
      metadata: restoreMetadata(output.Metadata),
      text: async () => decoder.decode(bytes),
      json: async <T = unknown>() => JSON.parse(decoder.decode(bytes)) as T,
      // Node Buffers can be views into a shared pool; copy just our slice.
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const output = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        key,
        size: output.ContentLength ?? 0,
        uploaded: output.LastModified ?? new Date(0),
        etag: output.ETag,
        contentType: output.ContentType,
        metadata: restoreMetadata(output.Metadata),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async put(key: string, body: string | ArrayBuffer | Uint8Array, options?: PutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: toBody(body),
        ContentType: options?.contentType,
        CacheControl: options?.cacheControl,
        Metadata: encodeMetadata(options?.metadata),
      })
    );
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async list(prefix: string): Promise<ListResult> {
    const objects: ObjectInfo[] = [];
    let continuationToken: string | undefined;

    do {
      const page: ListObjectsV2CommandOutput = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        objects.push({
          key: item.Key,
          size: item.Size ?? 0,
          uploaded: item.LastModified ?? new Date(0),
          etag: item.ETag,
          metadata: {},
        });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    return { objects };
  }
}
