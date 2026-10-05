import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

describe('MemoryObjectStore', () => {
  let store: MemoryObjectStore;

  beforeEach(() => {
    store = new MemoryObjectStore();
  });

  it('returns null for missing keys from get and head', async () => {
    await expect(store.get('nope')).resolves.toBeNull();
    await expect(store.head('nope')).resolves.toBeNull();
  });

  it('round-trips string bodies, contentType and metadata', async () => {
    await store.put('user/a@example.com', JSON.stringify({ name: 'A' }), {
      contentType: 'application/json',
      metadata: { userId: 'u1' },
    });

    const obj = await store.get('user/a@example.com');
    expect(obj).not.toBeNull();
    expect(obj!.key).toBe('user/a@example.com');
    expect(obj!.contentType).toBe('application/json');
    expect(obj!.metadata).toEqual({ userId: 'u1' });
    expect(obj!.uploaded).toBeInstanceOf(Date);
    expect(obj!.size).toBe(JSON.stringify({ name: 'A' }).length);
    await expect(obj!.json()).resolves.toEqual({ name: 'A' });
    await expect(obj!.text()).resolves.toBe('{"name":"A"}');

    const head = await store.head('user/a@example.com');
    expect(head!.metadata).toEqual({ userId: 'u1' });
    expect(head!.contentType).toBe('application/json');
  });

  it('round-trips binary bodies (ArrayBuffer and Uint8Array)', async () => {
    await store.put('bin/a', new Uint8Array([1, 2, 3]).buffer);
    await store.put('bin/b', new Uint8Array([4, 5]));
    const a = await store.get('bin/a');
    const b = await store.get('bin/b');
    expect(Array.from(new Uint8Array(await a!.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(await b!.arrayBuffer()))).toEqual([4, 5]);
  });

  it('copies inputs so later mutations do not leak in', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const metadata = { userId: 'u1' };
    await store.put('k', bytes, { metadata });
    bytes[0] = 99;
    metadata.userId = 'changed';
    const obj = await store.get('k');
    expect(Array.from(new Uint8Array(await obj!.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(obj!.metadata).toEqual({ userId: 'u1' });
  });

  it('keeps metadata keys exactly as given', async () => {
    await store.put('k', 'x', { metadata: { someCamelKey: 'v', lower: 'w' } });
    expect((await store.head('k'))!.metadata).toEqual({ someCamelKey: 'v', lower: 'w' });
  });

  it('overwrites existing keys', async () => {
    await store.put('k', 'one');
    await store.put('k', 'two');
    await expect((await store.get('k'))!.text()).resolves.toBe('two');
  });

  it('applies put synchronously (visible without awaiting)', async () => {
    void store.put('k', 'v');
    expect(store.size).toBe(1);
  });

  it('deletes keys and ignores missing ones', async () => {
    await store.put('k', 'v');
    await store.delete('k');
    await expect(store.get('k')).resolves.toBeNull();
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });

  it('lists every key under a prefix in sorted order, with empty metadata', async () => {
    await store.put('user/c', 'c', { metadata: { userId: 'c' }, contentType: 'application/json' });
    await store.put('user/a', 'a');
    await store.put('user-by-id/x', 'x');
    await store.put('user/b', 'b');
    await store.put('group/1', 'g');

    const result = await store.list('user/');
    expect(result.objects.map((o) => o.key)).toEqual(['user/a', 'user/b', 'user/c']);
    for (const obj of result.objects) {
      expect(obj.metadata).toEqual({});
      expect(obj.size).toBe(1);
      expect(obj.uploaded).toBeInstanceOf(Date);
    }

    const all = await store.list('');
    expect(all.objects.map((o) => o.key)).toEqual(['group/1', 'user-by-id/x', 'user/a', 'user/b', 'user/c']);
  });

  it('lists more than 1000 keys', async () => {
    for (let i = 0; i < 1500; i++) {
      await store.put(`k/${i}`, 'v');
    }
    expect((await store.list('k/')).objects).toHaveLength(1500);
  });

  it('clear removes everything', async () => {
    await store.put('a', '1');
    store.clear();
    expect((await store.list('')).objects).toEqual([]);
  });
});
