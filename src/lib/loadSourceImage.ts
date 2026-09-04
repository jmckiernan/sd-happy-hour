import fs from 'node:fs/promises';
import path from 'node:path';
import { readImage, storedImageUrlKey, type StoredImage } from './imageStore';

export const ALLOWED_SOURCE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

export interface LoadSourceImageOptions {
  requestUrl: URL;
  /** Forwarded from the admin request so same-origin fetches can pass
   *  Netlify visitor protection the admin already cleared in the browser. */
  cookieHeader?: string | null;
  maxBytes?: number;
}

function isSameOrigin(parsed: URL, requestUrl: URL): boolean {
  return parsed.origin === requestUrl.origin;
}

function contentTypeFromPath(pathname: string): string | null {
  const ext = path.extname(pathname).toLowerCase();
  return EXT_BY_CONTENT_TYPE[ext] || null;
}

/** Reads a committed static asset from public/ when the path is under /images/. */
async function readPublicStaticImage(pathname: string, maxBytes: number): Promise<StoredImage | null> {
  const normalized = path.posix.normalize(pathname);
  if (!normalized.startsWith('/images/') || normalized.includes('..')) return null;

  const publicRoot = path.resolve(path.join(process.cwd(), 'public'));
  const filePath = path.resolve(publicRoot, normalized.slice(1));
  if (!filePath.startsWith(`${publicRoot}${path.sep}`)) return null;

  const contentType = contentTypeFromPath(normalized);
  if (!contentType || !ALLOWED_SOURCE_CONTENT_TYPES.has(contentType)) return null;

  try {
    const bytes = await fs.readFile(filePath);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Image is too large (${maxBytes / (1024 * 1024)}MB max).`);
    }
    return { bytes: new Uint8Array(bytes), contentType };
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function fetchRemoteImage(
  parsed: URL,
  requestUrl: URL,
  cookieHeader: string | null | undefined,
  maxBytes: number,
): Promise<StoredImage> {
  const headers: Record<string, string> = {};
  if (cookieHeader && isSameOrigin(parsed, requestUrl)) {
    headers.cookie = cookieHeader;
  }

  const res = await fetch(parsed, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not fetch that URL (${res.status}).`);

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!ALLOWED_SOURCE_CONTENT_TYPES.has(contentType)) {
    throw new Error('That URL did not return a JPEG, PNG, WebP, GIF, or AVIF image.');
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new Error(`Image is too large (${maxBytes / (1024 * 1024)}MB max).`);
  return { bytes: new Uint8Array(buf), contentType };
}

/**
 * Loads image bytes for admin upload/edit flows without looping stored images
 * back through HTTP when avoidable. Stored blobs and committed public assets
 * are read directly; everything else is fetched, forwarding the admin's
 * cookies on same-origin requests so Netlify visitor protection does not 401
 * server-side fetches of /images/... paths the browser already loaded.
 */
export async function loadSourceImage(
  sourceUrl: string,
  options: LoadSourceImageOptions,
): Promise<StoredImage> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl, options.requestUrl);
  } catch {
    throw new Error('Provide a valid image URL.');
  }

  const storedKey = storedImageUrlKey(sourceUrl) ?? storedImageUrlKey(`${parsed.pathname}${parsed.search}`);
  if (storedKey) {
    const image = await readImage(storedKey);
    if (!image) throw new Error('Could not find that stored image — it may have been deleted.');
    if (image.bytes.byteLength > maxBytes) {
      throw new Error(`Image is too large (${maxBytes / (1024 * 1024)}MB max).`);
    }
    return image;
  }

  const staticImage = await readPublicStaticImage(parsed.pathname, maxBytes);
  if (staticImage) return staticImage;

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('Provide a valid http(s) image URL or a stored /api/images/ path.');
  }

  return fetchRemoteImage(parsed, options.requestUrl, options.cookieHeader, maxBytes);
}
