import { ObjectStore } from '../../src/storage/objectStore';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

/**
 * An ObjectStore whose methods are jest mocks that delegate to a real MemoryObjectStore.
 * Tests get real storage semantics and can still assert calls, use
 * `mockResolvedValueOnce`/`mockImplementation`, or replace a method outright.
 */
export type MockObjectStore = {
  [K in keyof ObjectStore]: jest.MockedFunction<ObjectStore[K]>;
} & {
  backing: MemoryObjectStore;
};

export function createMockObjectStore(backing: MemoryObjectStore = new MemoryObjectStore()): MockObjectStore {
  return {
    backing,
    get: jest.fn((key: string) => backing.get(key)),
    head: jest.fn((key: string) => backing.head(key)),
    put: jest.fn((key: string, body: string | ArrayBuffer | Uint8Array, options?) => backing.put(key, body, options)),
    delete: jest.fn((key: string) => backing.delete(key)),
    list: jest.fn((prefix: string) => backing.list(prefix)),
  };
}

/**
 * Build a StoredObject-like value for `mockResolvedValue` on `get`, from a JSON-able value.
 */
export function storedJson(key: string, value: unknown, extra: { contentType?: string; metadata?: Record<string, string> } = {}) {
  const text = JSON.stringify(value);
  return {
    key,
    size: text.length,
    uploaded: new Date(),
    contentType: extra.contentType,
    metadata: extra.metadata || {},
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
  };
}
