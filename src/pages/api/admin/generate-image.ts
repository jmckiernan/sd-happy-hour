import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../lib/api';
import { saveImage, makeImageKey } from '../../../lib/imageStore';
import { callGeminiImage } from '../../../lib/aiImages';
import { describeStoredImage } from '../../../lib/imageMetadata';

export const prerender = false;

// Nudges every generated image toward something that actually works as a
// blog hero image on this site, without the admin having to type this out
// each time — same idea as CONTENT_BRIEF in generate-draft.ts steering the
// text model toward this site's voice.
const STYLE_SUFFIX =
  'Photorealistic photo, warm inviting bar/restaurant atmosphere, suited as a blog hero image. ' +
  'Landscape orientation. No text, logos, or watermarks anywhere in the image.';

export const POST: APIRoute = async ({ request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email first.'], 401);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch (err: any) {
    return errorJson([err.message], 400);
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const slug = typeof body.slug === 'string' && body.slug.trim() ? body.slug.trim() : 'image';
  if (!prompt) return errorJson(['Describe the image you want (a prompt).'], 400);

  let generated;
  try {
    generated = await callGeminiImage([{ text: `${prompt}\n\n${STYLE_SUFFIX}` }]);
  } catch (err: any) {
    return errorJson([`Image generation failed: ${err.message}`], 502);
  }

  const key = makeImageKey(slug, generated.contentType);
  try {
    await saveImage(key, generated.bytes, generated.contentType);
  } catch (err: any) {
    return errorJson([`Could not save image: ${err.message}`], 502);
  }

  await describeStoredImage({
    key,
    bytes: generated.bytes,
    contentType: generated.contentType,
    origin: 'generated',
    // The admin's prompt, not the STYLE_SUFFIX-appended version actually sent
    // to Gemini — the suffix is boilerplate applied to every generation and
    // storing it on each row would just be noise.
    prompt,
    slugHint: slug,
    createdBy: admin.email,
  });

  return json({ success: true, url: `/api/images/${key}` });
};
