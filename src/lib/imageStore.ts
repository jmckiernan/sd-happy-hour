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

// Netlify sets NETLIFY=true both for real deploys and under `netlify dev`
// (which is what gives Blobs a sandboxed local store to use). Plain
// `astro dev` has neither, so this is a reliable way to tell them apart.
export function isNetlifyBlobsAvailable(): boolean {
  return Boolean(process.env.NETLIFY);
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

  await Promise.all([
    fs.rm(localDataPath(key), { force: true }),
    fs.rm(localMetaPath(key), { force: true }),
  ]);
}
