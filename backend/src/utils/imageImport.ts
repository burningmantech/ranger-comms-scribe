/**
 * Server-side image import for the editor (POST /api/content/editor-images/import): fetch a
 * public https image so the browser can upload a copy to the gallery. The URL comes from
 * pasted content, so this is an SSRF surface:
 *   - https only, default port, no credentials in the URL;
 *   - every address the host resolves to must be public (no private, loopback, link-local,
 *     metadata, CGNAT, multicast or unique-local IPv6), and the connection is pinned to the
 *     addresses that were checked, so a second DNS answer can't swap in an internal one;
 *   - redirects are followed by hand (at most 3) and each hop is checked the same way;
 *   - the response must be image/* (not SVG), is capped while streaming, and has a deadline.
 */
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

export const IMAGE_IMPORT_MAX_BYTES = 15 * 1024 * 1024;
export const IMAGE_IMPORT_TIMEOUT_MS = 15_000;
export const IMAGE_IMPORT_MAX_REDIRECTS = 3;

export class ImageImportError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ImageImportError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Stop reading and close the connection. */
  destroy(): void;
}

/** Make one GET request to `url`, connecting only to `addresses` (already checked). */
export type ImageTransport = (
  url: URL,
  options: { addresses: ResolvedAddress[]; signal: AbortSignal },
) => Promise<TransportResponse>;

export interface FetchPublicImageOptions {
  /** DNS: every address for a hostname. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  transport?: ImageTransport;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

// --- address checks ---------------------------------------------------------------------

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including 169.254.169.254 (instance metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as Array<[string, number]>) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (includes fd00:ec2::254, the IPv6 metadata endpoint)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as Array<[string, number]>) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (net.isIPv4(dotted[1]) === false) return null;
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    text = text.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function ipv4FromGroups(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/** True only for globally routable unicast addresses. Anything unparseable is not public. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;

  const g = ipv6Groups(address);
  if (!g) return false;
  // IPv6 forms that carry an IPv4 address: judge the IPv4 address.
  const upperZero = g.slice(0, 5).every((x) => x === 0);
  if (upperZero && (g[5] === 0xffff || g[5] === 0)) return isPublicAddress(ipv4FromGroups(g[6], g[7])); // mapped / compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicAddress(ipv4FromGroups(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPublicAddress(ipv4FromGroups(g[1], g[2])); // 6to4
  return !blocked.check(address, 'ipv6');
}

// --- fetching ---------------------------------------------------------------------------

const defaultResolve = async (hostname: string): Promise<ResolvedAddress[]> =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/** Node https, pinned to the checked addresses (the lookup never asks DNS again). */
export const httpsTransport: ImageTransport = (url, { addresses, signal }) =>
  new Promise((resolve, reject) => {
    const lookup = (_host: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
      if (options && options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    };
    const request = https.get(
      url,
      {
        lookup: lookup as any,
        signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ScrivenlyImageImport/1.0)',
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
        },
      },
      (response) => {
        resolve({
          status: response.statusCode || 0,
          headers: response.headers,
          body: response,
          destroy: () => response.destroy(),
        });
      },
    );
    request.on('error', reject);
  });

function header(headers: TransportResponse['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Throws unless `raw` is an https URL we are willing to connect to (before DNS). */
export function parseImportUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new ImageImportError('Invalid image URL', 400);
  }
  if (url.protocol !== 'https:') throw new ImageImportError('Only https image URLs can be imported', 400);
  if (url.username || url.password) throw new ImageImportError('Image URLs with credentials are not allowed', 400);
  if (url.port && url.port !== '443') throw new ImageImportError('Image URLs must use the default https port', 400);
  return url;
}

async function resolvePublic(
  url: URL,
  resolve: (hostname: string) => Promise<ResolvedAddress[]>,
): Promise<ResolvedAddress[]> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses: ResolvedAddress[];
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new ImageImportError(`Could not resolve ${host}`, 400);
    }
  }
  if (addresses.length === 0) throw new ImageImportError(`Could not resolve ${host}`, 400);
  if (addresses.some((a) => !isPublicAddress(a.address))) {
    throw new ImageImportError('Image URL points to a non-public address', 400);
  }
  return addresses;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Fetch a public https image. Throws ImageImportError (with an HTTP status) when it can't. */
export async function fetchPublicImage(
  rawUrl: string,
  options: FetchPublicImageOptions = {},
): Promise<{ data: Buffer; contentType: string }> {
  const resolve = options.resolve || defaultResolve;
  const transport = options.transport || httpsTransport;
  const maxBytes = options.maxBytes ?? IMAGE_IMPORT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? IMAGE_IMPORT_MAX_REDIRECTS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? IMAGE_IMPORT_TIMEOUT_MS);
  const timeoutError = () => new ImageImportError('Timed out fetching the image', 504);

  // Settle as soon as the deadline passes, even if the transport ignores the signal.
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(timeoutError()), { once: true });
  });
  deadline.catch(() => undefined);

  let response: TransportResponse | undefined;
  try {
    let url = parseImportUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      const addresses = await Promise.race([resolvePublic(url, resolve), deadline]);
      try {
        response = await Promise.race([transport(url, { addresses, signal: controller.signal }), deadline]);
      } catch (error) {
        if (error instanceof ImageImportError) throw error;
        if (controller.signal.aborted) throw timeoutError();
        throw new ImageImportError('Could not fetch the image', 502);
      }

      if (!REDIRECTS.has(response.status)) break;
      const location = header(response.headers, 'location');
      response.destroy();
      response = undefined;
      if (!location) throw new ImageImportError('Redirect without a location', 502);
      if (hop >= maxRedirects) throw new ImageImportError('Too many redirects', 502);
      url = parseImportUrl(location, url);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new ImageImportError(`The image server answered ${response.status}`, 502);
    }

    const contentType = (header(response.headers, 'content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') {
      throw new ImageImportError(`Not an image (${contentType || 'no content type'})`, 415);
    }
    const declared = Number(header(response.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ImageImportError('Image is too large', 413);
    }

    const body = response.body;
    const read = async (): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of body) {
        total += chunk.length;
        if (total > maxBytes) throw new ImageImportError('Image is too large', 413);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    };
    let data: Buffer;
    try {
      data = await Promise.race([read(), deadline]);
    } catch (error) {
      if (error instanceof ImageImportError) throw error;
      if (controller.signal.aborted) throw timeoutError();
      throw new ImageImportError('Could not read the image', 502);
    }
    return { data, contentType };
  } finally {
    clearTimeout(timer);
    response?.destroy();
  }
}
