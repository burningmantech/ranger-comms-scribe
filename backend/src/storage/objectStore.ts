/**
 * Storage abstraction that replaces the Cloudflare R2 binding.
 *
 * Code never imports a concrete store; it reads `env.STORE`.
 * See docs/plans/2026-10-04-aws-migration-contracts.md §1.
 */

export interface ObjectInfo {
  key: string;
  size: number;
  uploaded: Date;
  etag?: string;
  contentType?: string;              // from S3 ContentType
  metadata: Record<string, string>;  // user metadata, keys restored to camelCase
}

export interface StoredObject extends ObjectInfo {
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface ListResult {
  objects: ObjectInfo[];  // ALL keys under the prefix (implementations paginate internally);
                          // list results carry metadata = {} (S3 ListObjectsV2 has no user metadata)
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;   // null when missing (NoSuchKey/404)
  head(key: string): Promise<ObjectInfo | null>;    // null when missing
  put(key: string, body: string | ArrayBuffer | Uint8Array, options?: PutOptions): Promise<void>;
  delete(key: string): Promise<void>;               // no error when missing
  list(prefix: string): Promise<ListResult>;
}
