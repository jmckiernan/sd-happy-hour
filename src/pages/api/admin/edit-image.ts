import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../lib/api';
import { saveImage, makeImageKey } from '../../../lib/imageStore';
import { callGeminiImage } from '../../../lib/aiImages';
import { describeStoredImage } from '../../../lib/imageMetadata';
import { ALLOWED_SOURCE_CONTENT_TYPES, loadSourceImage } from '../../../lib/loadSourceImage';

export const prerender = false;

const ALLOWED_CONTENT_TYPES = ALLOWED_SOURCE_CONTENT_TYPES;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB, same cap as upload-image.ts

// Frames a bare edit request as an actual edit instruction — the same job
// STYLE_SUFFIX does for generate-image.ts.
//
// What this fixes is drift, not weak edits. Sending the admin's phrase through
// alone, the model treats the source as a reference rather than the thing being
// modified: results came back re-cropped and re-composed (wider framing, moved
// elements) even when the requested change itself landed. Pinning composition,
// framing, and aspect ratio keeps the result recognizably the same photo.
//
// What it does NOT fix, tested directly against the model: a vague or purely
// tonal request ("brighter lighting", "make it brighter") comes back as a
// near-identical re-render no matter how the instruction is framed — including
// with an explicit "a result that looks the same as the input is a failure".
// Requests that change scene *content* ("bright midday daylight, sun through
// the windows", "add a potted palm in the front left corner") land reliably.
// That's a model limitation, so the admin screens steer toward end-state
// wording and show the result rather than the endpoint pretending otherwise.
//
// Only the "edit the current image" path gets this. A freshly attached photo
// (the multipart branch below) is a "make an image from this starting point"
// request where wholesale reinterpretation is the point, and it already works.
function buildEditPrompt(prompt: string): string {
  return (
    `Edit the image provided. Apply this change: ${prompt}\n\n` +
    'Change only what that asks for. Keep the composition, subjects, framing, ' +
    'aspect ratio, and overall style of the original image identical — this is ' +
    'an edit of the given image, not a new image inspired by it. Return the ' +
    'edited image. No text, logos, or watermarks anywhere in the image.'
  );
}

export const POST: APIRoute = async ({ request, cookies, url }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email first.'], 401);

  const contentType = request.headers.get('content-type') || '';
  let prompt: string;
  let slug: string;
  let source: { bytes: Uint8Array; contentType: string };
  // Which image this edit started from, when it started from a stored one.
  // Recorded with the result so an edit chain stays traceable back to its
  // original; null when the source was a freshly attached file that was never
  // stored in its own right.
  let editedFrom: string | null = null;
  // True for the "edit the current image" path, which is the one that needs
  // buildEditPrompt()'s scaffolding; false when starting from an attached photo.
  let isCurrentImageEdit = false;

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
      editedFrom = sourceUrl;
      isCurrentImageEdit = true;
      source = await loadSourceImage(sourceUrl, {
        requestUrl: url,
        cookieHeader: request.headers.get('cookie'),
        maxBytes: MAX_BYTES,
      });
    }
  } catch (err: any) {
    return errorJson([err.message], 400);
  }

  if (!prompt) return errorJson(['Describe the edit you want.'], 400);

  let edited;
  try {
    edited = await callGeminiImage([
      { inlineData: { mimeType: source.contentType, data: Buffer.from(source.bytes).toString('base64') } },
      { text: isCurrentImageEdit ? buildEditPrompt(prompt) : prompt },
    ], {
      feature: 'admin_image_edit',
    });
  } catch (err: any) {
    return errorJson([`Image edit failed: ${err.message}`], 502);
  }

  const key = makeImageKey(slug, edited.contentType);
  try {
    await saveImage(key, edited.bytes, edited.contentType);
  } catch (err: any) {
    return errorJson([`Could not save image: ${err.message}`], 502);
  }

  await describeStoredImage({
    key,
    bytes: edited.bytes,
    contentType: edited.contentType,
    origin: 'edited',
    // The admin's raw prompt, not buildEditPrompt()'s expanded version — the
    // scaffolding is boilerplate on every edit, same reasoning as
    // generate-image.ts storing the prompt without its STYLE_SUFFIX.
    prompt,
    sourceUrl: editedFrom,
    slugHint: slug,
    createdBy: admin.email,
  });

  // Saved under a new key rather than overwriting the source — keeps the
  // original intact (matches makeImageKey()'s "never overwritten" contract
  // that /api/images/[key].ts relies on for its immutable cache header) and
  // lets the admin undo an edit by just re-pasting the old URL.
  return json({ success: true, url: `/api/images/${key}` });
};
