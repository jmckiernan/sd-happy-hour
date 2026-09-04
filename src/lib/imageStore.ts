import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Storage for actual image files (blog featured images), as opposed to just
// hotlinking someone else's URL. Same reasoning as kv.ts: production runs on
// Netlify, which has zero-config object storage built in (Netlify Blobs —
// no separate account/service to set up) — but plain `astro dev` isn't
// running inside Netlify's platform, so Blobs isn't available there. This
// falls back to writing files under `.data/images/` (gitignored) locally,
// exactly like kv.ts falls back to `.data/*.json` for accounts data.
// ---------------------------------------------------------------------------

const LOCAL_IMAGE_DIR = path.join(process.cwd(), '.data', 'images');
const STORE_NAME = 'blog-images';

// Detecting whether Netlify Blobs is usable.
//
// This used to check `process.env.NETLIFY` alone, which was wrong in the
// one environment that mattered most. `NETLIFY` is *build* metadata: it's
// set while `astro build` runs (and by `netlify dev`), but Netlify exposes
// only three read-only variables to serverless functions at runtime —
// `URL`, `SITE_NAME`, and `SITE_ID`. `NETLIFY` is not one of them, and Vite
// leaves `process.env.NETLIFY` as a runtime lookup rather than inlining it,
// so in a deployed function the check returned false and every read/write
// silently took the local-disk branch below. Uploads landed on the function
// container's ephemeral filesystem: they served correctly while that
// container stayed warm, then 404'd permanently once it recycled.
//
// `SITE_ID` is the runtime-available signal, so it's the one that decides
// this in production; `NETLIFY` is kept for the build and `netlify dev`.
//
// UPDATE: netlify dev sets SITE_ID but Netlify Blobs doesn't work reliably
// in local dev (connection refused errors). Check for NETLIFY_DEV and DEV to distinguish
// between netlify dev (where we want local storage) and actual deployed functions.
export function isNetlifyBlobsAvailable(): boolean {
  // If we're in dev mode (either Vite DEV or NETLIFY_DEV), use local storage
  if ((import.meta as any).env?.DEV === true) return false;
  if (process.env.NETLIFY_DEV === 'true') return false;
  if (process.env.CONTEXT === 'dev') return false;

  // Otherwise use SITE_ID as the signal - it's set in deployed functions but not plain astro dev
  return Boolean(process.env.SITE_ID);
}

// Whether it's legitimate to fall back to writing files under `.data/`.
// That fallback exists for plain `astro dev`, where there's no Blobs
// backend at all — it is never correct in a deployed build, where the
// filesystem is ephemeral and per-container. `import.meta.env.DEV` is
// substituted by Vite at build time, so unlike the env sniffing above it
// can't be wrong at runtime.
export function isLocalImageStorageAvailable(): boolean {
  return (import.meta as any).env?.DEV === true;
}

// Guards every code path that would otherwise reach for local disk. If a
// deployed build ever loses its Blobs signal again, this turns it into a
// visible 502 at upload time instead of an image that quietly works until
// the container recycles.
function assertLocalFallbackAllowed(operation: string): void {
  if (isLocalImageStorageAvailable()) return;
  throw new Error(
    `Cannot ${operation}: Netlify Blobs is unavailable and the local-disk fallback ` +
      `is only safe under \`astro dev\` (storage in a deployed function is ephemeral). ` +
      `Expected SITE_ID or NETLIFY to be set.`
  );
}

export interface StoredImage {
  bytes: Uint8Array;
  contentType: string;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export function extForContentType(contentType: string): string {
  return EXT_BY_CONTENT_TYPE[contentType] || 'jpg';
}

// Keys double as local filenames when falling back to disk, so this both
// makes a readable, collision-resistant key AND sanitizes away anything
// that isn't safe as a path segment.
export function makeImageKey(slugHint: string, contentType: string): string {
  const ext = extForContentType(contentType);
  const safeSlug =
    slugHint
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'image';
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${safeSlug}-${Date.now()}-${suffix}.${ext}`;
}

function localDataPath(key: string): string {
  return path.join(LOCAL_IMAGE_DIR, key);
}
function localMetaPath(key: string): string {
  return path.join(LOCAL_IMAGE_DIR, `${key}.meta.json`);
}

export async function saveImage(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  console.log('[imageStore] saveImage called for key:', key);
  console.log('[imageStore] Environment check - SITE_ID:', process.env.SITE_ID, 'NETLIFY:', process.env.NETLIFY);
  console.log('[imageStore] isNetlifyBlobsAvailable():', isNetlifyBlobsAvailable());

  if (isNetlifyBlobsAvailable()) {
    console.log('[imageStore] Using Netlify Blobs storage');
    try {
      const { getStore } = await import('@netlify/blobs');
      console.log('[imageStore] Imported getStore from @netlify/blobs');
      const store = getStore(STORE_NAME);
      console.log('[imageStore] Got store for:', STORE_NAME);
      // @netlify/blobs deliberately accepts ArrayBuffer rather than an
      // arbitrary ArrayBufferView. Copying also guarantees that a
      // SharedArrayBuffer-backed caller can never violate that contract.
      const payload = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(payload).set(bytes);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const result = await store.set(key, payload, {
        metadata: { contentType, sha256 },
        // Generated keys should never overwrite an existing upload. Besides
        // protecting the old file, this gives us an authoritative modified
        // flag that can be enforced before a URL is returned to the editor.
        onlyIfNew: true,
      });
      console.log('[imageStore] store.set() result:', result);
      if (!result.modified) {
        throw new Error(`Image key already exists and was not overwritten: ${key}`);
      }

      // Reads default to eventual consistency. A save followed immediately by
      // the public image endpoint could therefore 404 even though the write
      // succeeded. Verify through a strong read and enforce the result before
      // returning the URL to the admin form.
      try {
        const verification = await store.getWithMetadata(key, {
          type: 'arrayBuffer',
          consistency: 'strong',
        });
        const verifiedSha256 = verification
          ? crypto.createHash('sha256').update(new Uint8Array(verification.data)).digest('hex')
          : '';
        if (
          !verification ||
          verification.data.byteLength !== bytes.byteLength ||
          verification.metadata?.contentType !== contentType ||
          verification.metadata?.sha256 !== sha256 ||
          verifiedSha256 !== sha256
        ) {
          throw new Error(`Image upload could not be verified in durable storage: ${key}`);
        }
      } catch (err) {
        // The conditional write proved this invocation created the key, so it
        // is safe to clean it up if verification fails rather than leaving an
        // unreferenced object behind.
        try {
          await store.delete(key);
        } catch (cleanupErr) {
          console.error('[imageStore] Could not clean up unverified image:', cleanupErr);
        }
        throw err;
      }
      console.log('[imageStore] Successfully saved and verified in Netlify Blobs');
      return;
    } catch (err) {
      console.error('[imageStore] ERROR saving to Netlify Blobs:', err);
      throw err;
    }
  }

  console.log('[imageStore] Using local file storage fallback');
  assertLocalFallbackAllowed('save image');
  await fs.mkdir(LOCAL_IMAGE_DIR, { recursive: true });
  await fs.writeFile(localDataPath(key), bytes);
  await fs.writeFile(localMetaPath(key), JSON.stringify({ contentType }));
  console.log('[imageStore] Successfully saved to local storage');
}

/** Strict lookup for write paths that must distinguish a missing object from
 * a storage outage/configuration error. Public reads use readImage() below to
 * degrade either case to a normal 404. */
export async function readImageStrict(key: string): Promise<StoredImage | null> {
  console.log('[imageStore] readImage called for key:', key);
  console.log('[imageStore] Environment check - CONTEXT:', process.env.CONTEXT, 'SITE_ID:', process.env.SITE_ID);
  console.log('[imageStore] isNetlifyBlobsAvailable():', isNetlifyBlobsAvailable());

  if (isNetlifyBlobsAvailable()) {
    console.log('[imageStore] Reading from Netlify Blobs');
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(STORE_NAME);
    console.log('[imageStore] Got store for:', STORE_NAME);
    // Strong reads make a just-uploaded image available to the image route
    // immediately after the admin presses Save instead of briefly 404ing at
    // the edge while Blob replicas converge.
    const result = await store.getWithMetadata(key, {
      type: 'arrayBuffer',
      consistency: 'strong',
    });
    console.log('[imageStore] getWithMetadata result:', result ? 'found' : 'not found');
    if (!result) return null;
    const contentType = (result.metadata?.contentType as string) || 'application/octet-stream';
    console.log('[imageStore] Successfully read from Netlify Blobs, contentType:', contentType);
    return { bytes: new Uint8Array(result.data), contentType };
  }

  // Reads stay non-fatal — a missing image should 404, not 500 — but a
  // deployed build reaching this branch means Blobs detection is broken
  // again, which is worth saying out loud in the function logs rather than
  // leaving as a silent 404.
  console.log('[imageStore] Netlify Blobs not available, checking if local fallback is allowed');
  if (!isLocalImageStorageAvailable()) {
    throw new Error(
      '[imageStore] Netlify Blobs unavailable in a deployed build; ' +
        'cannot read image. CONTEXT=' + process.env.CONTEXT +
        ' isLocalImageStorageAvailable=' + isLocalImageStorageAvailable()
    );
  }

  try {
    const [bytes, metaRaw] = await Promise.all([
      fs.readFile(localDataPath(key)),
      fs.readFile(localMetaPath(key), 'utf-8'),
    ]);
    const meta = JSON.parse(metaRaw);
    return { bytes: new Uint8Array(bytes), contentType: meta.contentType || 'application/octet-stream' };
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function storedImageUrlKey(url: string): string | null {
  let pathname = url;
  if (!pathname.startsWith('/')) {
    try {
      pathname = new URL(url).pathname;
    } catch {
      return null;
    }
  }
  const match = pathname.match(/^\/api\/images\/([^/?#]+)\/?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Non-stored paths and remote URLs are treated as available; stored images
 * must exist in durable storage. */
export async function isStoredImageUrlAvailable(url: string): Promise<boolean> {
  if (!url) return false;
  const key = storedImageUrlKey(url);
  if (!key) return true;
  try {
    return Boolean(await readImageStrict(key));
  } catch {
    return false;
  }
}

export async function readImage(key: string): Promise<StoredImage | null> {
  try {
    return await readImageStrict(key);
  } catch (err) {
    console.error('[imageStore] ERROR reading image:', err);
    return null;
  }
}

export async function deleteImage(key: string): Promise<void> {
  if (isNetlifyBlobsAvailable()) {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(STORE_NAME);
    await store.delete(key);
    return;
  }

  assertLocalFallbackAllowed('delete image');
  await Promise.all([
    fs.rm(localDataPath(key), { force: true }),
    fs.rm(localMetaPath(key), { force: true }),
  ]);
}
