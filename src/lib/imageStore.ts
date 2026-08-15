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
export function isNetlifyBlobsAvailable(): boolean {
  return Boolean(process.env.SITE_ID || process.env.NETLIFY);
}

// Whether it's legitimate to fall back to writing files under `.data/`.
// That fallback exists for plain `astro dev`, where there's no Blobs
// backend at all — it is never correct in a deployed build, where the
// filesystem is ephemeral and per-container. `import.meta.env.DEV` is
// substituted by Vite at build time, so unlike the env sniffing above it
// can't be wrong at runtime.
function isLocalDevFallbackAllowed(): boolean {
  return import.meta.env.DEV === true;
}

// Guards every code path that would otherwise reach for local disk. If a
// deployed build ever loses its Blobs signal again, this turns it into a
// visible 502 at upload time instead of an image that quietly works until
// the container recycles.
function assertLocalFallbackAllowed(operation: string): void {
  if (isLocalDevFallbackAllowed()) return;
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
  if (isNetlifyBlobsAvailable()) {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(STORE_NAME);
    await store.set(key, bytes, { metadata: { contentType } });
    return;
  }

  assertLocalFallbackAllowed('save image');
  await fs.mkdir(LOCAL_IMAGE_DIR, { recursive: true });
  await fs.writeFile(localDataPath(key), bytes);
  await fs.writeFile(localMetaPath(key), JSON.stringify({ contentType }));
}

export async function readImage(key: string): Promise<StoredImage | null> {
  if (isNetlifyBlobsAvailable()) {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(STORE_NAME);
    const result = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!result) return null;
    const contentType = (result.metadata?.contentType as string) || 'application/octet-stream';
    return { bytes: new Uint8Array(result.data), contentType };
  }

  // Reads stay non-fatal — a missing image should 404, not 500 — but a
  // deployed build reaching this branch means Blobs detection is broken
  // again, which is worth saying out loud in the function logs rather than
  // leaving as a silent 404.
  if (!isLocalDevFallbackAllowed()) {
    console.error(
      '[imageStore] Netlify Blobs unavailable in a deployed build; ' +
        'cannot read image. Expected SITE_ID or NETLIFY to be set.'
    );
    return null;
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
