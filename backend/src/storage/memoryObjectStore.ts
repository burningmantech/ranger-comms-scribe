import { ListResult, ObjectInfo, ObjectStore, PutOptions, StoredObject } from './objectStore';

interface MemoryEntry {
  bytes: Uint8Array;
  uploaded: Date;
  etag: string;
  contentType?: string;
  cacheControl?: string;
  metadata: Record<string, string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(body: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof body === 'string') {
    return encoder.encode(body);
  }
  if (body instanceof Uint8Array) {
    return new Uint8Array(body); // copy so later caller mutations don't leak in
  }
  return new Uint8Array(body.slice(0));
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * In-process ObjectStore backed by a Map, for tests and quick local runs.
 * Metadata keys are kept exactly as given. `list` returns keys in sorted order.
 */
export class MemoryObjectStore implements ObjectStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private etagCounter = 0;

  private info(key: string, entry: MemoryEntry): ObjectInfo {
    return {
      key,
      size: entry.bytes.byteLength,
      uploaded: new Date(entry.uploaded.getTime()),
      etag: entry.etag,
      contentType: entry.contentType,
      metadata: { ...entry.metadata },
    };
  }

  get(key: string): Promise<StoredObject | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }
    const bytes = entry.bytes;
    const stored: StoredObject = {
      ...this.info(key, entry),
      text: async () => decoder.decode(bytes),
      json: async <T = unknown>() => JSON.parse(decoder.decode(bytes)) as T,
      arrayBuffer: async () => copyBuffer(bytes),
    };
    return Promise.resolve(stored);
  }

  head(key: string): Promise<ObjectInfo | null> {
    const entry = this.entries.get(key);
    return Promise.resolve(entry ? this.info(key, entry) : null);
  }

  // Not declared async on purpose: the write lands synchronously, so callers that
  // forget to await (some test fixtures do) still see the object immediately.
  put(key: string, body: string | ArrayBuffer | Uint8Array, options?: PutOptions): Promise<void> {
    this.etagCounter += 1;
    this.entries.set(key, {
      bytes: toBytes(body),
      uploaded: new Date(),
      etag: `"mem-${this.etagCounter}"`,
      contentType: options?.contentType,
      cacheControl: options?.cacheControl,
      metadata: { ...(options?.metadata || {}) },
    });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<ListResult> {
    const keys = Array.from(this.entries.keys())
      .filter((key) => key.startsWith(prefix))
      .sort();
    const objects = keys.map((key) => {
      const info = this.info(key, this.entries.get(key)!);
      // Match S3 ListObjectsV2: no content type or user metadata in listings.
      return { ...info, contentType: undefined, metadata: {} };
    });
    return Promise.resolve({ objects });
  }

  /** Test/debug helper: remove every object. */
  clear(): void {
    this.entries.clear();
  }

  /** Test/debug helper: number of stored objects. */
  get size(): number {
    return this.entries.size;
  }
}
