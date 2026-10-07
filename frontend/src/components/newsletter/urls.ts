import { API_URL } from '../../config';

/**
 * A stored image URL for an <img> in the app. Gallery URLs are stored relative to the site
 * (/api/gallery/<file>); when the API is on another origin (local development against
 * production) they need its origin.
 */
export function galleryImageUrl(src: string): string {
  if (!src.startsWith('/api/')) return src;
  try {
    return new URL(src, new URL(API_URL, window.location.href).origin).href;
  } catch {
    return src;
  }
}

/** http(s) or mailto. */
export function isWebUrl(value: string): boolean {
  return /^(https?:\/\/|mailto:)\S+$/i.test(value.trim());
}
