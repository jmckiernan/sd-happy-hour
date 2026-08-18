import type { APIRoute } from 'astro';
import { getVenues } from '../../../../../lib/venues';
import {
  createVenuePhoto,
  countVenuePhotos,
  listVenuePhotosForOwner,
  recordImage,
} from '../../../../../lib/store';
import { getVenueManager, NOT_A_MANAGER_MESSAGE } from '../../../../../lib/venueManager';
import { saveImage, makeImageKey } from '../../../../../lib/imageStore';
import { sanitizeUploadedImage } from '../../../../../lib/imageSanitize';
import { screenImage, moderationRecord } from '../../../../../lib/imageModeration';
import { cleanString } from '../../../../../lib/validation';
import { json, errorJson } from '../../../../../lib/api';

export const prerender = false;

// Owner photo uploads — the album on the venue page, and the source of menu
// item photos.
//
// The pipeline, in order, and why it's in this order:
//
//   1. Authorize (verified claim on *this* venue, or admin).
//   2. Enforce the per-venue cap, before spending any work on the bytes.
//   3. Sanitize (src/lib/imageSanitize.ts) — format sniffing, dimension
//      checks, EXIF/GPS stripping, trailing-payload truncation. Cheap, local,
//      and it rejects hostile files before they reach either storage or a
//      third-party API.
//   4. Screen the *sanitized* bytes (src/lib/imageModeration.ts). Screening
//      what we're actually going to store, rather than what was uploaded,
//      means the two can't diverge.
//   5. Store, and record the verdict on the row.
//
// A rejected photo is not stored at all: there's no reason to keep bytes we've
// decided can't be shown, and doing so would mean holding exactly the content
// we least want to hold.

const MAX_BYTES = 8 * 1024 * 1024;
// Big enough that a hero-sized crop still looks sharp, small enough to reject
// a thumbnail someone saved off a web page.
const MIN_WIDTH = 800;
const MIN_HEIGHT = 500;
// Roughly a 50MP photo. Above this the Image CDN work per render gets silly
// and it's almost certainly an unresized RAW export.
const MAX_DIMENSION = 8000;
// Per venue, counting everything not rejected. Generous for a real album,
// bounded enough that a compromised account can't fill the store.
const MAX_PHOTOS_PER_VENUE = 40;

export const GET: APIRoute = async ({ params, cookies }) => {
  const venueId = Number(params.id);
  if (!Number.isInteger(venueId) || venueId <= 0) return errorJson(['Invalid venue id.'], 400);

  const manager = await getVenueManager(cookies, venueId);
  if (!manager) return errorJson([NOT_A_MANAGER_MESSAGE], 403);

  // Includes in-review and rejected photos: the owner needs to see that a
  // photo is waiting, and why one was refused, instead of it just not being
  // there.
  const photos = await listVenuePhotosForOwner(venueId);
  return json({
    photos: photos.map((photo) => ({
      id: photo.id,
      url: `/api/images/${photo.imageKey}`,
      caption: photo.caption,
      status: photo.status,
      reason: (photo.moderation?.reason as string) || photo.reviewNote || '',
      sortOrder: photo.sortOrder,
      createdAt: photo.createdAt,
    })),
    limit: MAX_PHOTOS_PER_VENUE,
  });
};

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const venueId = Number(params.id);
  if (!Number.isInteger(venueId) || venueId <= 0) return errorJson(['Invalid venue id.'], 400);

  const manager = await getVenueManager(cookies, venueId);
  if (!manager) return errorJson([NOT_A_MANAGER_MESSAGE], 403);

  const venue = getVenues().find((entry) => entry.id === venueId);
  if (!venue) return errorJson(['Venue not found.'], 404);

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    // No fetch-from-URL path here, unlike the admin uploader: server-side
    // fetching of a URL supplied by a semi-trusted user is an SSRF surface,
    // and an owner uploading their own photos has no need for it.
    return errorJson(['Upload the photo as a file.'], 400);
  }

  const existingCount = await countVenuePhotos(venueId);
  if (existingCount >= MAX_PHOTOS_PER_VENUE) {
    return errorJson(
      [`This listing already has ${MAX_PHOTOS_PER_VENUE} photos, which is the limit. Delete one to add another.`],
      409
    );
  }

  let file: File;
  let caption: string;
  try {
    const form = await request.formData();
    const candidate = form.get('file');
    if (!(candidate instanceof File)) return errorJson(['No photo was attached.'], 400);
    file = candidate;
    caption = cleanString(form.get('caption')).slice(0, 200);
  } catch (err: any) {
    return errorJson([`Could not read the upload: ${err.message}`], 400);
  }

  if (file.size > MAX_BYTES) {
    return errorJson([`That photo is too large (${Math.floor(MAX_BYTES / 1024 / 1024)}MB max).`], 400);
  }

  const raw = new Uint8Array(await file.arrayBuffer());
  const sanitized = sanitizeUploadedImage(raw, file.type, {
    maxBytes: MAX_BYTES,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxDimension: MAX_DIMENSION,
  });
  if (!sanitized.ok) return errorJson([sanitized.error], 400);

  // Admin uploads skip screening — an admin looking at the photo as they
  // upload it is a stronger check than the model, and it keeps the admin's own
  // album management from queueing work for the admin.
  const verdict = manager.isAdmin
    ? null
    : await screenImage({ bytes: sanitized.bytes, contentType: sanitized.contentType });

  if (verdict?.decision === 'reject') {
    return errorJson(
      [
        verdict.reason ||
          'That photo was refused by automated screening. Photos should show the venue, its food, or its drinks.',
      ],
      422
    );
  }

  const status = verdict === null || verdict.decision === 'publish' ? 'published' : 'in_review';

  const key = makeImageKey(`venue-${venueId}`, sanitized.contentType);
  try {
    await saveImage(key, sanitized.bytes, sanitized.contentType);
  } catch (err: any) {
    return errorJson([`Could not save that photo: ${err.message}`], 502);
  }

  // The provenance row has to exist before the album row: venue_photos.image_key
  // references images(key).
  await recordImage({
    key,
    contentType: sanitized.contentType,
    byteSize: sanitized.bytes.length,
    width: sanitized.width,
    height: sanitized.height,
    origin: manager.isAdmin ? 'upload' : 'owner',
    slugHint: `venue-${venueId}`,
    createdBy: manager.user.email,
  });

  const photo = await createVenuePhoto({
    venueId,
    imageKey: key,
    caption,
    status,
    moderation: verdict ? moderationRecord(verdict) : null,
    uploadedBy: manager.user.id,
  });

  return json(
    {
      photo: {
        id: photo.id,
        url: `/api/images/${key}`,
        caption: photo.caption,
        status: photo.status,
        reason: verdict?.reason || '',
        sortOrder: photo.sortOrder,
      },
      // What the dashboard tells the owner to expect.
      pendingReview: status === 'in_review',
    },
    201
  );
};
