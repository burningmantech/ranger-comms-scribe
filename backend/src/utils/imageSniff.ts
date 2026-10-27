/**
 * Raster image types the gallery accepts, detected from the file's first bytes. The
 * gallery is served from the site's own origin, so the type is never taken from the
 * upload's declared type or file name: an SVG or HTML file served from there could run
 * script with a signed-in viewer's session.
 */
export type SniffedImage = { contentType: string; ext: string };

const startsWith = (bytes: Uint8Array, sig: number[], offset = 0) =>
  bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: 'image/png', ext: 'png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { contentType: 'image/jpeg', ext: 'jpg' };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { contentType: 'image/gif', ext: 'gif' }; // GIF8
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { contentType: 'image/webp', ext: 'webp' }; // RIFF....WEBP
  }
  // ....ftypavif / ....ftypavis (AVIF still or sequence; the image import asks servers for AVIF first)
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) &&
      (startsWith(bytes, [0x61, 0x76, 0x69, 0x66], 8) || startsWith(bytes, [0x61, 0x76, 0x69, 0x73], 8))) {
    return { contentType: 'image/avif', ext: 'avif' };
  }
  return null;
}
