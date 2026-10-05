import {
  fetchPublicImage,
  ImageImportError,
  ImageTransport,
  isPublicAddress,
  parseImportUrl,
  ResolvedAddress,
  TransportResponse,
} from '../../src/utils/imageImport';
import { importEditorImage } from '../../src/handlers/contentSubmission';
import { AddressInfo } from 'net';
import { createAppServer } from '../../src/httpServer';
import { configureCors } from '../../src/index';
import { loadConfig } from '../../src/config/env';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

type Reply = { status?: number; headers?: Record<string, string>; chunks?: Uint8Array[] };

/** Fake DNS: hostname -> addresses. */
function dnsFrom(table: Record<string, string[]>) {
  return jest.fn(async (hostname: string): Promise<ResolvedAddress[]> => {
    const addresses = table[hostname];
    if (!addresses) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });
}

/** Fake transport: URL -> reply. Records the URLs and pinned addresses it was asked to use. */
function transportFrom(replies: Record<string, Reply>) {
  const calls: Array<{ url: string; addresses: string[] }> = [];
  const destroyed: string[] = [];
  const transport: ImageTransport = async (url, { addresses }) => {
    calls.push({ url: url.href, addresses: addresses.map((a) => a.address) });
    const reply = replies[url.href];
    if (!reply) throw new Error(`unexpected request ${url.href}`);
    const response: TransportResponse = {
      status: reply.status ?? 200,
      headers: Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: (async function* () {
        for (const chunk of reply.chunks ?? []) yield chunk;
      })(),
      destroy: () => destroyed.push(url.href),
    };
    return response;
  };
  return { transport, calls, destroyed };
}

const png = (size: number) => new Uint8Array(size).fill(7);

async function expectImportError(promise: Promise<unknown>, status: number, message?: RegExp) {
  await expect(promise).rejects.toBeInstanceOf(ImageImportError);
  await promise.catch((error: ImageImportError) => {
    expect(error.status).toBe(status);
    if (message) expect(error.message).toMatch(message);
  });
}

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::abcd', 'fd00:ec2::254', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
    '64:ff9b::a9fe:a9fe', '2002:c0a8:0101::1', 'not-an-ip', '',
  ])('rejects %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '142.250.72.14', '172.32.0.1', '2607:f8b0:4005:80a::200e', '::ffff:8.8.8.8', '2a00:1450:4001::1'])(
    'accepts %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('parseImportUrl', () => {
  it.each([
    ['http://example.com/a.png', /https/],
    ['file:///etc/passwd', /https/],
    ['ftp://example.com/a.png', /https/],
    ['https://user:pw@example.com/a.png', /credentials/],
    ['https://example.com:8443/a.png', /port/],
    ['not a url', /Invalid/],
  ])('rejects %s', (url, message) => {
    expect(() => parseImportUrl(url)).toThrow(message);
  });

  it('accepts a plain https URL', () => {
    expect(parseImportUrl('https://lh7-rt.googleusercontent.com/docsz/abc?key=1').hostname).toBe('lh7-rt.googleusercontent.com');
  });
});

describe('fetchPublicImage', () => {
  it('fetches a public image, pinning the connection to the checked addresses', async () => {
    const resolve = dnsFrom({ 'images.example.com': ['93.184.216.34'] });
    const { transport, calls } = transportFrom({
      'https://images.example.com/cat.png': { headers: { 'Content-Type': 'image/png; charset=binary' }, chunks: [png(10), png(5)] },
    });
    const result = await fetchPublicImage('https://images.example.com/cat.png', { resolve, transport });
    expect(result.contentType).toBe('image/png');
    expect(result.data.length).toBe(15);
    expect(calls).toEqual([{ url: 'https://images.example.com/cat.png', addresses: ['93.184.216.34'] }]);
  });

  it.each([
    ['loopback', ['127.0.0.1']],
    ['private', ['10.0.0.5']],
    ['metadata', ['169.254.169.254']],
    ['unique-local IPv6', ['fd12:3456::1']],
    ['IPv4-mapped loopback', ['::ffff:127.0.0.1']],
    ['one private address among public ones', ['93.184.216.34', '192.168.0.10']],
  ])('refuses a host that resolves to a %s address, without connecting', async (_label, addresses) => {
    const resolve = dnsFrom({ 'evil.example.com': addresses });
    const { transport, calls } = transportFrom({});
    await expectImportError(fetchPublicImage('https://evil.example.com/x.png', { resolve, transport }), 400, /non-public/);
    expect(calls).toHaveLength(0);
  });

  it.each(['https://127.0.0.1/x.png', 'https://[::1]/x.png', 'https://169.254.169.254/latest/meta-data', 'https://2130706433/x.png', 'https://[::ffff:a00:1]/x.png'])(
    'refuses the IP literal %s without DNS or connecting',
    async (url) => {
      const resolve = dnsFrom({});
      const { transport, calls } = transportFrom({});
      await expectImportError(fetchPublicImage(url, { resolve, transport }), 400, /non-public/);
      expect(resolve).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses http:// before resolving anything', async () => {
    const resolve = dnsFrom({ 'example.com': ['93.184.216.34'] });
    const { transport } = transportFrom({});
    await expectImportError(fetchPublicImage('http://example.com/a.png', { resolve, transport }), 400, /https/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('follows redirects, re-checking every hop', async () => {
    const resolve = dnsFrom({ 'a.example.com': ['93.184.216.34'], 'cdn.example.net': ['151.101.1.1'] });
    const { transport, calls } = transportFrom({
      'https://a.example.com/img': { status: 302, headers: { Location: 'https://cdn.example.net/real.jpg' } },
      'https://cdn.example.net/real.jpg': { headers: { 'Content-Type': 'image/jpeg' }, chunks: [png(3)] },
    });
    const result = await fetchPublicImage('https://a.example.com/img', { resolve, transport });
    expect(result.contentType).toBe('image/jpeg');
    expect(calls.map((c) => c.url)).toEqual(['https://a.example.com/img', 'https://cdn.example.net/real.jpg']);
    expect(resolve).toHaveBeenCalledWith('cdn.example.net');
  });

  it('resolves relative redirect locations against the current URL', async () => {
    const resolve = dnsFrom({ 'a.example.com': ['93.184.216.34'] });
    const { transport } = transportFrom({
      'https://a.example.com/img': { status: 301, headers: { Location: '/files/real.gif' } },
      'https://a.example.com/files/real.gif': { headers: { 'Content-Type': 'image/gif' }, chunks: [png(1)] },
    });
    await expect(fetchPublicImage('https://a.example.com/img', { resolve, transport })).resolves.toMatchObject({ contentType: 'image/gif' });
  });

  it('refuses a redirect to a host that resolves to a private address', async () => {
    const resolve = dnsFrom({ 'a.example.com': ['93.184.216.34'], 'internal.example.com': ['10.0.0.7'] });
    const { transport, calls } = transportFrom({
      'https://a.example.com/img': { status: 302, headers: { Location: 'https://internal.example.com/secret' } },
    });
    await expectImportError(fetchPublicImage('https://a.example.com/img', { resolve, transport }), 400, /non-public/);
    expect(calls.map((c) => c.url)).toEqual(['https://a.example.com/img']);
  });

  it.each(['https://169.254.169.254/latest/meta-data/', 'http://cdn.example.net/x.png', 'https://cdn.example.net:8080/x.png'])(
    'refuses a redirect to %s',
    async (location) => {
      const resolve = dnsFrom({ 'a.example.com': ['93.184.216.34'], 'cdn.example.net': ['151.101.1.1'] });
      const { transport, calls } = transportFrom({
        'https://a.example.com/img': { status: 307, headers: { Location: location } },
      });
      await expectImportError(fetchPublicImage('https://a.example.com/img', { resolve, transport }), 400);
      expect(calls).toHaveLength(1);
    },
  );

  it('gives up after 3 redirects', async () => {
    const resolve = dnsFrom({ 'a.example.com': ['93.184.216.34'] });
    const replies: Record<string, Reply> = {};
    for (let i = 0; i < 5; i++) {
      replies[`https://a.example.com/${i}`] = { status: 302, headers: { Location: `/${i + 1}` } };
    }
    const { transport, calls } = transportFrom(replies);
    await expectImportError(fetchPublicImage('https://a.example.com/0', { resolve, transport }), 502, /redirects/);
    expect(calls).toHaveLength(4); // the original request plus 3 redirects
  });

  it.each(['text/html', 'application/octet-stream', 'image/svg+xml', ''])('refuses content type "%s"', async (type) => {
    const resolve = dnsFrom({ 'a.example.com': ['93.184.216.34'] });
    const { transport, destroyed } = transportFrom({
      'https://a.example.com/x': { headers: type ? { 'Content-Type': type } : {}, chunks: [png(4)] },
    });
    await expectImportError(fetchPublicImage('https://a.example.com/x', { resolve, transport }), 415, /Not an image/);
    expect(destroyed).toContain('https://a.example.com/x');
  });

  it('refuses an image whose declared length is over the cap, before reading it', async () => {
    const resolve = dnsFrom({ 'a.example.com': ['93.184.216.34'] });
    const { transport } = transportFrom({
      'https://a.example.com/big': { headers: { 'Content-Type': 'image/png', 'Content-Length': '2000' }, chunks: [] },
    });
    await expectImportError(fetchPublicImage('https://a.example.com/big', { resolve, transport, maxBytes: 1000 }), 413);
  });

  it('stops reading once the streamed body passes the cap (no or false content-length)', async () => {
    const resolve = dnsFrom({ 'a.example.com': ['93.184.216.34'] });
    let yielded = 0;
    const transport: ImageTransport = async () => ({
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '10' },
      body: (async function* () {
        for (let i = 0; i < 100; i++) {
          yielded++;
          yield png(400);
        }
      })(),
      destroy: () => undefined,
    });
    await expectImportError(fetchPublicImage('https://a.example.com/big', { resolve, transport, maxBytes: 1000 }), 413, /too large/);
    expect(yielded).toBe(3);
  });

  it('times out a slow server', async () => {
    const resolve = dnsFrom({ 'slow.example.com': ['93.184.216.34'] });
    let sawAbort = false;
    const transport: ImageTransport = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('aborted'));
        });
      });
    await expectImportError(fetchPublicImage('https://slow.example.com/x.png', { resolve, transport, timeoutMs: 20 }), 504);
    expect(sawAbort).toBe(true);
  });

  it('times out a body that stalls mid-stream', async () => {
    const resolve = dnsFrom({ 'slow.example.com': ['93.184.216.34'] });
    const transport: ImageTransport = async () => ({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: (async function* () {
        yield png(10);
        await new Promise(() => undefined); // never finishes
      })(),
      destroy: () => undefined,
    });
    await expectImportError(fetchPublicImage('https://slow.example.com/x.png', { resolve, transport, timeoutMs: 20 }), 504);
  });

  it('reports an upstream error status as 502', async () => {
    const resolve = dnsFrom({ 'a.example.com': ['93.184.216.34'] });
    const { transport } = transportFrom({ 'https://a.example.com/x': { status: 404, headers: { 'Content-Type': 'text/html' } } });
    await expectImportError(fetchPublicImage('https://a.example.com/x', { resolve, transport }), 502, /404/);
  });

  it('reports a host that does not resolve as 400', async () => {
    const { transport } = transportFrom({});
    await expectImportError(fetchPublicImage('https://nope.example.com/x', { resolve: dnsFrom({}), transport }), 400, /resolve/);
  });
});

describe('importEditorImage (route handler)', () => {
  const post = (body: unknown) =>
    new Request('http://localhost/api/content/editor-images/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('returns the image bytes with its content type', async () => {
    const resolve = dnsFrom({ 'a.example.com': ['93.184.216.34'] });
    const { transport } = transportFrom({ 'https://a.example.com/x.webp': { headers: { 'Content-Type': 'image/webp' }, chunks: [png(6)] } });
    const response = await importEditorImage(post({ imageUrl: 'https://a.example.com/x.webp' }), { resolve, transport });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/webp');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect((await response.arrayBuffer()).byteLength).toBe(6);
  });

  it('maps a refused URL to its status with a JSON error', async () => {
    const response = await importEditorImage(post({ imageUrl: 'https://127.0.0.1/x.png' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringMatching(/non-public/) });
  });

  it.each([[{}], [{ imageUrl: 42 }], ['not json']])('rejects a bad body %p', async (body) => {
    const response = await importEditorImage(post(body));
    expect(response.status).toBe(400);
  });
});

describe('import routes through the app server', () => {
  async function post(path: string, body: unknown, extraEnv: Record<string, string> = {}, headers: Record<string, string> = {}) {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const env = loadConfig(
      {
        PUBLIC_URL: 'http://localhost/api', FRONTEND_URL: 'http://localhost:3000', GOOGLE_CLIENT_ID: 'c',
        TURNSTILESECRET: 's', STORE_DRIVER: 'memory', ...extraEnv,
      },
      { store: new MemoryObjectStore() },
    ).env;
    configureCors(env.CORS_ORIGINS);
    const app = createAppServer(env);
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = app.server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    } finally {
      await app.close();
      jest.restoreAllMocks();
    }
  }

  const paths = ['/api/content/editor-images/import', '/api/content/editor-images/proxy-google-docs'];

  it.each(paths)('%s needs a session', async (path) => {
    expect(await post(path, { imageUrl: 'https://example.com/a.png' })).toEqual({ status: 400, body: { error: 'Session ID is required' } });
    expect((await post(path, { imageUrl: 'https://example.com/a.png' }, {}, { Authorization: 'Bearer nope' })).status).toBe(403);
  });

  it.each(paths)('%s is mounted and runs the guarded import', async (path) => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(path, { imageUrl: 'https://169.254.169.254/latest/meta-data/' }, { DEV_BYPASS_AUTH: 'true' });
    expect(res).toEqual({ status: 400, body: { error: 'Image URL points to a non-public address' } });
  });
});
