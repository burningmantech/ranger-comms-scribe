/**
 * Images that arrive by paste or drop (pasted HTML from Google Docs or web pages, screenshots,
 * dropped files). Each one becomes a pending ImageNode (a skeleton) in the document; the client
 * that created it uploads a copy to the gallery and swaps the gallery URLs in (ImagePlugin).
 *
 * The original source (a URL or a File) never goes into the document: it stays in this
 * client's registry below, keyed by the placeholder's imageId. Only this client can finish
 * the import, and a placeholder nobody owns is cleaned up once it is stale.
 */
import { API_URL } from '../../../config';

/** Largest image we import (the backend import endpoint enforces the same cap). */
export const MAX_IMPORT_IMAGE_BYTES = 15 * 1024 * 1024;

/** A placeholder older than this with no client uploading it is an orphan (its uploader left). */
export const PENDING_IMAGE_STALE_MS = 5 * 60 * 1000;

/** The client gives up on one image after this long (proxy + upload). */
export const IMAGE_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;

export type ImageSrcKind =
  | 'gallery' // already in our gallery: keep as-is
  | 'data' // data:image/... : upload directly
  | 'blob' // blob: URL from this page's origin: read it, then upload
  | 'remote' // public https:// image (Google Docs or any site): import through the backend
  | 'unsupported'; // file:, http:, blob: from another origin, relative paths, SVG, ...

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Origins whose /api/gallery/ paths are our own gallery: the page and the API. */
function galleryOrigins(): Set<string> {
  const origins = new Set<string>();
  if (typeof window !== 'undefined' && window.location?.origin) origins.add(window.location.origin);
  const api = originOf(API_URL);
  if (api) origins.add(api);
  return origins;
}

/** Decide what to do with an `<img src>` from pasted content. */
export function classifyImageSrc(rawSrc: string, ownOrigins: Set<string> = galleryOrigins()): ImageSrcKind {
  const src = (rawSrc || '').trim();
  if (!src) return 'unsupported';

  if (src.startsWith('/api/gallery/')) return 'gallery';

  const lower = src.toLowerCase();
  if (lower.startsWith('data:')) {
    // Raster images only: an SVG served from our origin could carry script.
    return /^data:image\/(png|jpe?g|gif|webp|bmp|avif)[;,]/.test(lower) ? 'data' : 'unsupported';
  }
  if (lower.startsWith('blob:')) {
    // blob:<origin>/<uuid>; only this page can read its own blobs.
    const origin = originOf(src.slice('blob:'.length));
    return origin && ownOrigins.has(origin) ? 'blob' : 'unsupported';
  }

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return 'unsupported'; // relative path that isn't our gallery
  }
  if (ownOrigins.has(url.origin) && url.pathname.startsWith('/api/gallery/')) return 'gallery';
  if (url.protocol === 'https:') return 'remote';
  return 'unsupported';
}

export type PendingImageSource = { kind: 'url'; src: string } | { kind: 'file'; file: File };

interface RegistryEntry {
  source: PendingImageSource;
  registeredAt: number;
}

const registry = new Map<string, RegistryEntry>();
const REGISTRY_TTL_MS = 10 * 60 * 1000;

let counter = 0;
export function newPendingImageId(): string {
  counter += 1;
  return `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${counter}`;
}

/** Remember where a placeholder's image comes from (this client only). */
export function registerPendingImageSource(id: string, source: PendingImageSource): void {
  const now = Date.now();
  // Entries for placeholders that never reached a mounted editor would otherwise linger.
  registry.forEach((entry, key) => {
    if (now - entry.registeredAt > REGISTRY_TTL_MS) registry.delete(key);
  });
  registry.set(id, { source, registeredAt: now });
}

/** Take ownership of a placeholder's source (once). */
export function takePendingImageSource(id: string): PendingImageSource | undefined {
  const entry = registry.get(id);
  if (entry) registry.delete(id);
  return entry?.source;
}

/** Parse a width/height attribute or a px style value into a number of pixels. */
export function parseImageDimension(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(value);
  if (!match) return undefined;
  const n = Math.round(parseFloat(match[1]));
  return n > 0 ? n : undefined;
}

/** The skeleton shown while an image is being imported (rendered locally, never stored). */
export function skeletonImageDataUrl(width?: number, height?: number): string {
  const w = width && width > 0 ? width : 300;
  const h = height && height > 0 ? height : 200;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="100%" height="100%" rx="4" fill="#f6f7f8" stroke="#e1e4e8"/>` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="14" fill="#6a737d">Importing image…</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

function fileNameFor(type: string, hint?: string): string {
  const ext = EXTENSIONS[type] || 'img';
  const base = (hint || '').split('/').pop()?.split(/[?#]/)[0]?.replace(/\.[a-z0-9]+$/i, '') || '';
  const safe = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  return `${safe || `pasted-image-${Date.now()}`}.${ext}`;
}

/** Decode a data:image/...;base64 (or URL-encoded) URL into a File. */
export function dataUrlToFile(dataUrl: string): File {
  const match = /^data:([^;,]+)((?:;[^;,]*)*),([\s\S]*)$/.exec(dataUrl);
  if (!match) throw new Error('Malformed data URL');
  const type = match[1].toLowerCase();
  const isBase64 = /;base64/i.test(match[2]);
  let bytes: Uint8Array;
  if (isBase64) {
    const binary = atob(match[3].replace(/\s/g, ''));
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(match[3]));
  }
  return new File([bytes], fileNameFor(type), { type });
}

function checkImageFile(file: File): File {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    throw new Error(`Not a supported image type: ${file.type || 'unknown'}`);
  }
  if (file.size > MAX_IMPORT_IMAGE_BYTES) throw new Error('Image is too large');
  return file;
}

/** Turn a placeholder's source into an image File ready for the gallery upload. */
export async function resolveImageSource(source: PendingImageSource, signal?: AbortSignal): Promise<File> {
  if (source.kind === 'file') return checkImageFile(source.file);

  const kind = classifyImageSrc(source.src);
  if (kind === 'data') return checkImageFile(dataUrlToFile(source.src));
  if (kind === 'blob') {
    const blob = await (await fetch(source.src, { signal })).blob();
    return checkImageFile(new File([blob], fileNameFor(blob.type), { type: blob.type }));
  }
  if (kind !== 'remote') throw new Error(`Image source can't be imported: ${source.src.slice(0, 80)}`);

  const sessionId = localStorage.getItem('sessionId');
  if (!sessionId) throw new Error('Not signed in');
  const response = await fetch(`${API_URL}/content/editor-images/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionId}` },
    body: JSON.stringify({ imageUrl: source.src }),
    signal,
  });
  if (!response.ok) throw new Error(`Image import failed: ${response.status}`);
  const blob = await response.blob();
  const type = (response.headers.get('Content-Type') || blob.type || '').split(';')[0].trim().toLowerCase();
  return checkImageFile(new File([blob], fileNameFor(type, new URL(source.src).pathname), { type }));
}

export interface GalleryUploadResult {
  id: string;
  fileName: string;
  url: string;
  thumbnailUrl: string;
  mediumUrl: string;
}

/** Thumbnail (150x150, letterboxed) and medium (800px max) versions, made in the browser. */
function createImageVersions(file: File): Promise<{ thumbnail: File; medium: File }> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    const fail = (error: unknown) => {
      URL.revokeObjectURL(objectUrl);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    img.onload = () => {
      try {
        if (!ctx) throw new Error('Canvas is not available');
        canvas.width = 150;
        canvas.height = 150;
        const scale = Math.min(150 / img.width, 150 / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, 150, 150);
        ctx.drawImage(img, (150 - w) / 2, (150 - h) / 2, w, h);

        canvas.toBlob((thumbnailBlob) => {
          if (!thumbnailBlob) return fail(new Error('Failed to create thumbnail'));
          const thumbnail = new File([thumbnailBlob], `thumbnail_${file.name}`, { type: file.type });

          const max = 800;
          const mScale = img.width > max || img.height > max ? Math.min(max / img.width, max / img.height) : 1;
          canvas.width = img.width * mScale;
          canvas.height = img.height * mScale;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          canvas.toBlob((mediumBlob) => {
            URL.revokeObjectURL(objectUrl);
            if (!mediumBlob) return reject(new Error('Failed to create medium image'));
            resolve({ thumbnail, medium: new File([mediumBlob], `medium_${file.name}`, { type: file.type }) });
          }, file.type, 0.9);
        }, file.type, 0.9);
      } catch (error) {
        fail(error);
      }
    };
    img.onerror = () => fail(new Error('Failed to load image'));
    img.src = objectUrl;
  });
}

/** Upload an image File to the gallery (POST /content/editor-images/upload). */
export async function uploadImageToGallery(file: File, takenBy: string, signal?: AbortSignal): Promise<GalleryUploadResult> {
  const sessionId = localStorage.getItem('sessionId');
  if (!sessionId) throw new Error('Not signed in');

  const { thumbnail, medium } = await createImageVersions(file);
  const formData = new FormData();
  formData.append('media', file);
  formData.append('thumbnail', thumbnail);
  formData.append('medium', medium);
  formData.append('isPublic', 'true');
  formData.append('takenBy', takenBy);

  const response = await fetch(`${API_URL}/content/editor-images/upload`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
    headers: { Authorization: `Bearer ${sessionId}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${await response.text().catch(() => '')}`);
  }
  return response.json();
}
