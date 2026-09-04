import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../lib/admins';
import { json, errorJson } from '../../../lib/api';
import { saveImage, makeImageKey } from '../../../lib/imageStore';
import { readImageDimensions } from '../../../lib/imageDimensions';
import { describeStoredImage } from '../../../lib/imageMetadata';
import { ALLOWED_SOURCE_CONTENT_TYPES, loadSourceImage } from '../../../lib/loadSourceImage';

export const prerender = false;

const ALLOWED_CONTENT_TYPES = ALLOWED_SOURCE_CONTENT_TYPES;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB

// Below this, an image gets visibly grainy once it's stretched to fill the
// hero image box (up to ~900px wide on desktop, and up to 2x that in
// actual device pixels on a Retina/high-DPI screen) — so it's rejected up
// front instead of quietly making it onto the site looking soft. Only
// enforced for formats readImageDimensions() can actually parse
// (JPEG/PNG/GIF); WebP/AVIF skip this check rather than risk a wrong read.
const MIN_WIDTH = 1200;
const MIN_HEIGHT = 700;

// Two ways in: a direct file upload (multipart/form-data), or a remote URL
// to fetch server-side and store our own copy of (so a pasted Unsplash
// link, for example, stops being a hotlink to someone else's server and
// becomes an actual file this app owns). Both end up going through the
// same saveImage() call either way.
export const POST: APIRoute = async ({ request, cookies, url }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email first.'], 401);

  const contentType = request.headers.get('content-type') || '';
  let bytes: Uint8Array;
  let imageContentType: string;
  let slug = 'image';
  // Which of the two ways in was used, recorded alongside the image so the
  // provenance of a fetched-from-URL copy isn't lost the moment it stops
  // being a hotlink.
  let origin: 'upload' | 'url' = 'upload';
  let sourceUrl: string | null = null;

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      const slugField = form.get('slug');
      if (typeof slugField === 'string' && slugField.trim()) slug = slugField.trim();

      if (!(file instanceof File)) return errorJson(['No file provided.'], 400);
      if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
        return errorJson(['File must be a JPEG, PNG, WebP, GIF, or AVIF image.'], 400);
      }
      if (file.size > MAX_BYTES) return errorJson(['Image is too large (8MB max).'], 400);

      bytes = new Uint8Array(await file.arrayBuffer());
      imageContentType = file.type;
    } else {
      const body = await request.json();
      const rawUrl = body.url;
      if (typeof body.slug === 'string' && body.slug.trim()) slug = body.slug.trim();
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        return errorJson(['Provide a valid image URL or /images/... path.'], 400);
      }
      const imageUrl = rawUrl.trim();
      origin = 'url';
      sourceUrl = imageUrl;

      if (!imageUrl.startsWith('/') && !/^https?:\/\//.test(imageUrl)) {
        return errorJson(['Provide a valid http(s) image URL or /images/... path.'], 400);
      }

      let loaded;
      try {
        loaded = await loadSourceImage(imageUrl, {
          requestUrl: url,
          cookieHeader: request.headers.get('cookie'),
          maxBytes: MAX_BYTES,
        });
      } catch (err: any) {
        return errorJson([err.message], 502);
      }
      bytes = loaded.bytes;
      imageContentType = loaded.contentType;
    }
  } catch (err: any) {
    return errorJson([`Could not read image: ${err.message}`], 400);
  }

  const dimensions = readImageDimensions(bytes, imageContentType);
  if (dimensions && (dimensions.width < MIN_WIDTH || dimensions.height < MIN_HEIGHT)) {
    return errorJson(
      [
        `Image is too small (${dimensions.width}×${dimensions.height}px) — it'll look grainy once it's stretched to fill the post's hero image. ` +
          `Use one at least ${MIN_WIDTH}×${MIN_HEIGHT}px. If this came from Unsplash, make sure you used their "Download" button on the photo's page rather than saving the on-page preview.`,
      ],
      400
    );
  }

  const key = makeImageKey(slug, imageContentType);
  try {
    await saveImage(key, bytes, imageContentType);
  } catch (err: any) {
    return errorJson([`Could not save image: ${err.message}`], 502);
  }

  await describeStoredImage({
    key,
    bytes,
    contentType: imageContentType,
    origin,
    sourceUrl,
    slugHint: slug,
    createdBy: admin.email,
  });

  return json({ success: true, url: `/api/images/${key}` });
};
