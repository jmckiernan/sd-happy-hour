import type { APIRoute, AstroCookies } from 'astro';
import { getVenuePhoto, updateVenuePhoto, deleteVenuePhoto, type VenuePhoto } from '../../../../lib/store';
import { getVenueManager, NOT_A_MANAGER_MESSAGE, type VenueManager } from '../../../../lib/venueManager';
import { getSession } from '../../../../lib/session';
import { cleanString } from '../../../../lib/validation';
import { json, errorJson, readJsonBody } from '../../../../lib/api';

export const prerender = false;

// Caption, ordering and deletion for a single album photo.
//
// The venue this photo belongs to comes from the photo row itself rather than
// from the URL, so authorization can't be steered by passing someone else's
// venue id — the check is always against the owner of the photo being touched.

/** Returns the photo and the manager, or the Response to send back instead. */
async function loadAuthorized(
  photoId: string | undefined,
  cookies: AstroCookies
): Promise<Response | { photo: VenuePhoto; manager: VenueManager }> {
  if (!photoId) return errorJson(['Invalid photo id.'], 400);

  // Cheapest check first. The photo lookup below is what tells us which venue
  // to authorize against, but there's no reason to spend a query on an
  // anonymous caller — this keeps an unauthenticated flood off the database.
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  const photo = await getVenuePhoto(photoId);
  // 404 for a photo that doesn't exist; the generic manager message for one
  // that does and isn't theirs — no probing which ids are real.
  if (!photo) return errorJson(['Photo not found.'], 404);

  const manager = await getVenueManager(cookies, photo.venueId);
  if (!manager) return errorJson([NOT_A_MANAGER_MESSAGE], 403);

  return { photo, manager };
}

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const loaded = await loadAuthorized(params.photoId, cookies);
  if (loaded instanceof Response) return loaded;
  const { photo } = loaded;

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  // Status is deliberately not settable here. An owner can caption, reorder
  // and delete; only an admin (api/admin/photos.ts) moves a photo between
  // in_review / published / rejected, or the whole screening step would be
  // one PATCH away from being bypassed.
  const caption = body.caption === undefined ? undefined : cleanString(body.caption).slice(0, 200);
  const sortOrder =
    body.sortOrder === undefined || body.sortOrder === null ? undefined : Number(body.sortOrder);

  if (sortOrder !== undefined && (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 9999)) {
    return errorJson(['Invalid position.'], 422);
  }
  if (caption === undefined && sortOrder === undefined) {
    return errorJson(['Nothing to update.'], 400);
  }

  const updated = await updateVenuePhoto(photo.id, { caption, sortOrder });
  if (!updated) return errorJson(['Photo not found.'], 404);

  return json({
    photo: {
      id: updated.id,
      url: `/api/images/${updated.imageKey}`,
      caption: updated.caption,
      status: updated.status,
      sortOrder: updated.sortOrder,
    },
  });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const loaded = await loadAuthorized(params.photoId, cookies);
  if (loaded instanceof Response) return loaded;

  // Only the album row goes. The blob and its `images` record stay as the
  // record of what was uploaded, and any menu item pointing at this photo has
  // its photo_id nulled by the foreign key rather than breaking.
  const deleted = await deleteVenuePhoto(loaded.photo.id);
  if (!deleted) return errorJson(['Photo not found.'], 404);

  return json({ success: true });
};
