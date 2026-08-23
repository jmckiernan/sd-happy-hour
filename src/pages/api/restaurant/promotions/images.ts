import type { APIRoute } from 'astro';
import { errorJson, json } from '../../../../lib/api';
import { saveImage, makeImageKey } from '../../../../lib/imageStore';
import { sanitizeUploadedImage } from '../../../../lib/imageSanitize';
import { screenImage } from '../../../../lib/imageModeration';
import { createPromotionImage, countPromotionImagesForVenue } from '../../../../lib/promotionImageRepo';
import { getVerifiedPromotionClaim } from '../../../../lib/promotionAuthorization';
import { getSession } from '../../../../lib/session';
import { recordImage } from '../../../../lib/store';
import { getVenueById } from '../../../../lib/venues';

export const prerender = false;

const MAX_BYTES = 8 * 1024 * 1024;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 500;
const MAX_DIMENSION = 8000;
const MAX_PROMOTION_IMAGES_PER_VENUE = 40;

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);
  if (!(request.headers.get('content-type') || '').includes('multipart/form-data')) {
    return errorJson(['Upload the promotion image as a file.'], 400);
  }

  let venueId: number;
  let file: File;
  try {
    const form = await request.formData();
    venueId = Number(form.get('venueId'));
    const candidate = form.get('file');
    if (!(candidate instanceof File)) return errorJson(['No promotion image was attached.'], 400);
    file = candidate;
  } catch (error: any) {
    return errorJson([`Could not read the upload: ${error.message}`], 400);
  }

  if (!Number.isSafeInteger(venueId) || venueId <= 0 || !getVenueById(venueId)) {
    return errorJson(['Venue not found.'], 404);
  }
  if (!await getVerifiedPromotionClaim(session.userId, venueId)) {
    return errorJson(['You need a verified claim on this listing to upload promotion images.'], 403);
  }
  if (await countPromotionImagesForVenue(venueId) >= MAX_PROMOTION_IMAGES_PER_VENUE) {
    return errorJson(['This venue has reached its promotion image limit.'], 409);
  }
  if (file.size > MAX_BYTES) return errorJson(['That image is too large (8MB max).'], 400);

  const sanitized = sanitizeUploadedImage(new Uint8Array(await file.arrayBuffer()), file.type, {
    maxBytes: MAX_BYTES,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxDimension: MAX_DIMENSION,
  });
  if (sanitized.ok === false) return errorJson([sanitized.error], 400);

  const verdict = await screenImage({ bytes: sanitized.bytes, contentType: sanitized.contentType });
  if (verdict.decision === 'reject') {
    return errorJson([verdict.reason || 'That image was refused by automated screening.'], 422);
  }

  const key = makeImageKey(`promotion-${venueId}`, sanitized.contentType);
  try {
    await saveImage(key, sanitized.bytes, sanitized.contentType);
    await recordImage({
      key,
      contentType: sanitized.contentType,
      byteSize: sanitized.bytes.length,
      width: sanitized.width,
      height: sanitized.height,
      origin: 'owner',
      slugHint: `promotion-${venueId}`,
      createdBy: session.userId,
    });
    await createPromotionImage(venueId, key, session.userId);
  } catch (error: any) {
    return errorJson([`Could not save that promotion image: ${error.message}`], 502);
  }

  return json({ imageKey: key, url: `/api/images/${key}` }, 201);
};
