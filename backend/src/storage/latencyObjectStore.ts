import { ListResult, ObjectInfo, ObjectStore, PutOptions, StoredObject } from './objectStore';

/**
 * Wraps a store and delays every call by a random 0..maxMs, half before the call reaches
 * the inner store and half after it answers, as an S3 round trip would. Local testing only
 * (STORE_LATENCY_MS with STORE_DRIVER=memory): the in-memory store answers at once, which
 * hides races that S3's latency exposes, e.g. a read overtaken by a concurrent write.
 */
export class LatencyObjectStore implements ObjectStore {
  constructor(private readonly inner: ObjectStore, private readonly maxMs: number) {}

  private pause(): Promise<void> {
    const ms = Math.random() * this.maxMs / 2;
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async around<T>(call: () => Promise<T>): Promise<T> {
    await this.pause();
    const result = await call();
    await this.pause();
    return result;
  }

  get(key: string): Promise<StoredObject | null> {
    return this.around(() => this.inner.get(key));
  }

  head(key: string): Promise<ObjectInfo | null> {
    return this.around(() => this.inner.head(key));
  }

  put(key: string, body: string | ArrayBuffer | Uint8Array, options?: PutOptions): Promise<void> {
    return this.around(() => this.inner.put(key, body, options));
  }

  delete(key: string): Promise<void> {
    return this.around(() => this.inner.delete(key));
  }

  list(prefix: string): Promise<ListResult> {
    return this.around(() => this.inner.list(prefix));
  }
}
