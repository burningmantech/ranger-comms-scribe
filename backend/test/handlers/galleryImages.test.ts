import { serveGalleryImage } from '../../src/handlers/gallery';
import { MemoryObjectStore } from '../../src/storage/memoryObjectStore';

function envWith(store: MemoryObjectStore): any {
  return { STORE: store };
}

async function bodyText(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}

describe('serveGalleryImage', () => {
  let store: MemoryObjectStore;

  beforeEach(async () => {
    store = new MemoryObjectStore();
    await store.put('gallery/photo.jpg', 'original-bytes', { contentType: 'image/jpeg' });
    await store.put('gallery/thumbnails/photo.jpg', 'thumb-bytes', { contentType: 'image/jpeg' });
    await store.put('gallery/plain.png', 'png-original', { contentType: 'image/png' });
  });

  it('serves the original image with image headers', async () => {
    const response = await serveGalleryImage('photo.jpg', 'original', envWith(store));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000');
    expect(await bodyText(response)).toBe('original-bytes');
  });

  it('serves the thumbnail bytes, not JSON', async () => {
    const response = await serveGalleryImage('photo.jpg', 'thumbnail', envWith(store));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(await bodyText(response)).toBe('thumb-bytes');
  });

  it('falls back to the original when no resized copy exists', async () => {
    const response = await serveGalleryImage('plain.png', 'medium', envWith(store));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(await bodyText(response)).toBe('png-original');
  });

  it('returns 404 for missing files and non-image extensions', async () => {
    expect((await serveGalleryImage('missing.jpg', 'thumbnail', envWith(store))).status).toBe(404);
    expect((await serveGalleryImage('notes.txt', 'original', envWith(store))).status).toBe(404);
  });
});
