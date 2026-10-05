import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3ObjectStore, KNOWN_METADATA_KEYS } from '../../src/storage/s3ObjectStore';

function notFound(name: string) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
}

function bodyOf(text: string) {
  const bytes = new TextEncoder().encode(text);
  return { transformToByteArray: async () => bytes };
}

describe('S3ObjectStore', () => {
  let store: S3ObjectStore;
  let send: jest.SpyInstance;

  beforeEach(() => {
    store = new S3ObjectStore({ bucket: 'test-bucket', region: 'us-east-1' });
    send = jest.spyOn(S3Client.prototype, 'send') as unknown as jest.SpyInstance;
  });

  afterEach(() => {
    send.mockRestore();
  });

  describe('constructor', () => {
    it('uses path-style addressing when an endpoint is set (MinIO)', async () => {
      const minio = new S3ObjectStore({
        bucket: 'b',
        endpoint: 'http://localhost:9000',
        credentials: { accessKeyId: 'minio', secretAccessKey: 'minio123' },
      });
      expect(minio.client.config.forcePathStyle).toBe(true);
      const endpoint = await minio.client.config.endpoint!();
      expect(endpoint.hostname).toBe('localhost');
      expect(endpoint.port).toBe(9000);
    });

    it('does not force path-style without an endpoint', () => {
      expect(store.client.config.forcePathStyle).toBeFalsy();
    });
  });

  describe('list', () => {
    it('paginates with ContinuationToken until every key is returned (>1000 keys)', async () => {
      const allKeys = Array.from({ length: 2500 }, (_, i) => `user/${String(i).padStart(5, '0')}`);
      const pages = [allKeys.slice(0, 1000), allKeys.slice(1000, 2000), allKeys.slice(2000)];
      let call = 0;

      send.mockImplementation(async (command: unknown) => {
        if (!(command instanceof ListObjectsV2Command)) throw new Error('unexpected command');
        const index = call++;
        const keys = pages[index];
        const isLast = index === pages.length - 1;
        return {
          Contents: keys.map((Key) => ({ Key, Size: 10, LastModified: new Date('2026-01-01T00:00:00Z'), ETag: '"e"' })),
          IsTruncated: !isLast,
          NextContinuationToken: isLast ? undefined : `token-${index + 1}`,
        };
      });

      const result = await store.list('user/');

      expect(result.objects).toHaveLength(2500);
      expect(result.objects.map((o) => o.key)).toEqual(allKeys);
      expect(send).toHaveBeenCalledTimes(3);

      const inputs = send.mock.calls.map(([cmd]) => (cmd as ListObjectsV2Command).input);
      expect(inputs[0]).toEqual({ Bucket: 'test-bucket', Prefix: 'user/', ContinuationToken: undefined });
      expect(inputs[1].ContinuationToken).toBe('token-1');
      expect(inputs[2].ContinuationToken).toBe('token-2');

      const first = result.objects[0];
      expect(first.size).toBe(10);
      expect(first.uploaded).toEqual(new Date('2026-01-01T00:00:00Z'));
      expect(first.metadata).toEqual({});
    });

    it('returns an empty list when nothing matches', async () => {
      send.mockResolvedValue({ IsTruncated: false });
      const result = await store.list('nothing/');
      expect(result.objects).toEqual([]);
    });
  });

  describe('put', () => {
    it('sends ContentType, CacheControl and percent-encoded metadata', async () => {
      send.mockResolvedValue({});

      await store.put('gallery/café.jpg', new Uint8Array([1, 2, 3]).buffer, {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=31536000',
        metadata: { userId: 'u1', originalName: 'café.jpg', isPublic: 'true' },
      });

      expect(send).toHaveBeenCalledTimes(1);
      const command = send.mock.calls[0][0] as PutObjectCommand;
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input.Bucket).toBe('test-bucket');
      expect(command.input.Key).toBe('gallery/café.jpg');
      expect(command.input.ContentType).toBe('image/jpeg');
      expect(command.input.CacheControl).toBe('public, max-age=31536000');
      expect(command.input.Body).toBeInstanceOf(Uint8Array);
      expect(Array.from(command.input.Body as Uint8Array)).toEqual([1, 2, 3]);
      expect(command.input.Metadata).toEqual({
        userId: 'u1',
        originalName: 'caf%C3%A9.jpg',
        isPublic: 'true',
      });
      // Every header value must be ASCII.
      for (const value of Object.values(command.input.Metadata!)) {
        expect(/^[\x20-\x7e]*$/.test(value)).toBe(true);
      }
    });

    it('passes string bodies through', async () => {
      send.mockResolvedValue({});
      await store.put('session/abc', '{"a":1}', { contentType: 'application/json' });
      const command = send.mock.calls[0][0] as PutObjectCommand;
      expect(command.input.Body).toBe('{"a":1}');
      expect(command.input.Metadata).toBeUndefined();
    });
  });

  describe('get', () => {
    it('returns null on NoSuchKey', async () => {
      send.mockRejectedValue(notFound('NoSuchKey'));
      await expect(store.get('missing')).resolves.toBeNull();
    });

    it('returns null on a bare 404', async () => {
      send.mockRejectedValue(Object.assign(new Error('x'), { name: 'Unknown', $metadata: { httpStatusCode: 404 } }));
      await expect(store.get('missing')).resolves.toBeNull();
    });

    it('rethrows other errors', async () => {
      send.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
      await expect(store.get('secret')).rejects.toThrow('denied');
    });

    it('restores camelCase metadata keys from lowercase S3 keys and round-trips contentType', async () => {
      send.mockImplementation(async (command: unknown) => {
        expect(command).toBeInstanceOf(GetObjectCommand);
        return {
          Body: bodyOf('{"hello":"wörld"}'),
          ContentLength: 19,
          ContentType: 'application/json',
          ETag: '"abc"',
          LastModified: new Date('2026-02-03T04:05:06Z'),
          Metadata: {
            userid: 'u1',
            createdat: '2026-02-03T04%3A05%3A06Z',
            updatedat: '2026-02-04',
            ispublic: 'false',
            groupid: 'g1',
            takenby: 'Zo%C3%AB',
            memberid: 'm1',
            isthumbail: 'true',
            originalmediakey: 'gallery%2Fx.jpg',
            somethingelse: 'kept',
          },
        };
      });

      const obj = await store.get('blog/posts/1');
      expect(obj).not.toBeNull();
      expect(obj!.contentType).toBe('application/json');
      expect(obj!.etag).toBe('"abc"');
      expect(obj!.uploaded).toEqual(new Date('2026-02-03T04:05:06Z'));
      expect(obj!.metadata).toEqual({
        userId: 'u1',
        createdAt: '2026-02-03T04:05:06Z',
        updatedAt: '2026-02-04',
        isPublic: 'false',
        groupId: 'g1',
        takenBy: 'Zoë',
        memberId: 'm1',
        isThumbail: 'true',
        originalMediaKey: 'gallery/x.jpg',
        somethingelse: 'kept',
      });

      // Body can be read through any accessor, more than once.
      await expect(obj!.json()).resolves.toEqual({ hello: 'wörld' });
      await expect(obj!.text()).resolves.toBe('{"hello":"wörld"}');
      const buf = await obj!.arrayBuffer();
      expect(new TextDecoder().decode(buf)).toBe('{"hello":"wörld"}');
    });

    it('returns only the object bytes from arrayBuffer even when backed by a pooled buffer', async () => {
      const pool = new Uint8Array([9, 9, 1, 2, 3, 9]);
      const view = pool.subarray(2, 5);
      send.mockResolvedValue({ Body: { transformToByteArray: async () => view }, Metadata: {} });
      const obj = await store.get('k');
      const buf = await obj!.arrayBuffer();
      expect(Array.from(new Uint8Array(buf))).toEqual([1, 2, 3]);
    });
  });

  describe('head', () => {
    it('returns null on NotFound', async () => {
      send.mockRejectedValue(notFound('NotFound'));
      await expect(store.head('missing')).resolves.toBeNull();
    });

    it('returns info with restored metadata and contentType', async () => {
      send.mockImplementation(async (command: unknown) => {
        expect(command).toBeInstanceOf(HeadObjectCommand);
        return {
          ContentLength: 42,
          ContentType: 'image/png',
          LastModified: new Date('2026-01-01T00:00:00Z'),
          Metadata: { userid: 'u2', ispublic: 'true' },
        };
      });
      const info = await store.head('gallery/a.png');
      expect(info).toEqual({
        key: 'gallery/a.png',
        size: 42,
        uploaded: new Date('2026-01-01T00:00:00Z'),
        etag: undefined,
        contentType: 'image/png',
        metadata: { userId: 'u2', isPublic: 'true' },
      });
    });
  });

  describe('delete', () => {
    it('sends DeleteObject and ignores missing keys', async () => {
      send.mockResolvedValueOnce({});
      await store.delete('a');
      expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);

      send.mockRejectedValueOnce(notFound('NoSuchKey'));
      await expect(store.delete('b')).resolves.toBeUndefined();
    });
  });

  describe('metadata round-trip', () => {
    it('put then get restores every known key in camelCase', async () => {
      let saved: Record<string, string> = {};
      send.mockImplementation(async (command: unknown) => {
        if (command instanceof PutObjectCommand) {
          // Simulate S3 lowercasing user-metadata keys.
          saved = Object.fromEntries(
            Object.entries(command.input.Metadata || {}).map(([k, v]) => [k.toLowerCase(), v])
          );
          return {};
        }
        if (command instanceof GetObjectCommand) {
          return { Body: bodyOf('x'), ContentType: 'text/plain', Metadata: saved };
        }
        throw new Error('unexpected');
      });

      const metadata = Object.fromEntries(KNOWN_METADATA_KEYS.map((k) => [k, `value ✓ ${k}`]));
      await store.put('k', 'x', { contentType: 'text/plain', metadata });
      const obj = await store.get('k');
      expect(obj!.metadata).toEqual(metadata);
      expect(obj!.contentType).toBe('text/plain');
    });
  });
});
