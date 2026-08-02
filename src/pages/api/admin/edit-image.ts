import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../lib/api';
import { saveImage, makeImageKey, readImage } from '../../../lib/imageStore';
import { callGeminiImage } from '../../../lib/aiImages';

export const prerender = false;

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_BYTES = 8 * 1024 * 1024; // 8MB, same cap as upload-image.ts

// The image being edited is almost always one this app already stored
// (served at /api/images/<key>) — read it straight out of imageStore
// instead of looping the request back through fetch(). Anything else (a
// pasted external URL that was never "downloaded & stored") falls back to
// fetching it directly, same as upload-image.ts's URL path.
async function loadSourceImage(sourceUrl: string, requestUrl: URL): Promise<{ bytes: Uint8Array; contentType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl, requestUrl);
  } catch {
    throw new Error('Provide a valid image URL.');
  }

  const ownMatch = parsed.pathname.match(/^\/api\/images\/([^/]+)$/);
  if (ownMatch) {
    const image = await readImage(decodeURIComponent(ownMatch[1]));
    if (!image) throw new Error('Could not find that stored image — it may have been deleted.');
    return image;
  }

  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Provide a valid http(s) image URL.');

  const res = await fetch(parsed);
  if (!res.ok) throw new Error(`Could not fetch that URL (${res.status}).`);

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error('That URL did not return a JPEG, PNG, WebP, GIF, or AVIF image.');
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) throw new Error('Image is too large (8MB max).');
  return { bytes: new Uint8Array(buf), contentType };
}

export const POST: APIRoute = async ({ request, cookies, url }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email first.'], 401);

  const contentType = request.headers.get('content-type') || '';
  let prompt: string;
  let slug: string;
  let source: { bytes: Uint8Array; contentType: string };

  try {
    if (contentType.includes('multipart/form-data')) {
      // A freshly attached "start from this photo" file — used as-is
      // without first round-tripping it through upload-image.ts/imageStore,
      // since the admin may not want to keep the untouched original.
      const form = await request.formData();
      const file = form.get('file');
      const promptField = form.get('prompt');
      const slugField = form.get('slug');

      prompt = typeof promptField === 'string' ? promptField.trim() : '';
      slug = typeof slugField === 'string' && slugField.trim() ? slugField.trim() : 'image';

      if (!(file instanceof File)) return errorJson(['No source image file provided.'], 400);
      if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
        return errorJson(['Source image must be a JPEG, PNG, WebP, GIF, or AVIF image.'], 400);
      }
      if (file.size > MAX_BYTES) return errorJson(['Source image is too large (8MB max).'], 400);

      source = { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type };
    } else {
      const body = await readJsonBody(request);
      prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      slug = typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : 'image';
      const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';

      if (!sourceUrl) return errorJson(['No current image to edit — generate or upload one first.'], 400);
      source = await loadSourceImage(sourceUrl, url);
    }
  } catch (err: any) {
    return errorJson([err.message], 400);
  }

  if (!prompt) return errorJson(['Describe the edit you want.'], 400);

  let edited;
  try {
    edited = await callGeminiImage([
      { inlineData: { mimeType: source.contentType, data: Buffer.from(source.bytes).toString('base64') } },
      { text: prompt },
    ]);
  } catch (err: any) {
    return errorJson([`Image edit failed: ${err.message}`], 502);
  }

  const key = makeImageKey(slug, edited.contentType);
  try {
    await saveImage(key, edited.bytes, edited.contentType);
  } catch (err: any) {
    return errorJson([`Could not save image: ${err.message}`], 502);
  }

  // Saved under a new key rather than overwriting the source — keeps the
  // original intact (matches makeImageKey()'s "never overwritten" contract
  // that /api/images/[key].ts relies on for its immutable cache header) and
  // lets the admin undo an edit by just re-pasting the old URL.
  return json({ success: true, url: `/api/images/${key}` });
};
