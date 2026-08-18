import type { APIRoute } from 'astro';
import { getVenues } from '../../../lib/venues';
import {
  listVenuePhotosForReview,
  getVenuePhoto,
  updateVenuePhoto,
  deleteVenuePhoto,
  type VenuePhoto,
} from '../../../lib/store';
import { getAdminUser } from '../../../lib/admins';
import { cleanString } from '../../../lib/validation';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// The moderation queue behind owner photo uploads.
//
// A photo lands in 'in_review' when automated screening flagged it as
// off-topic, returned something unreadable, or couldn't run at all (see
// src/lib/imageModeration.ts — it fails closed). This is where a human
// resolves those. Approving is the only way a held photo becomes public.

function venueNameById(): Map<number, string> {
  return new Map(getVenues().map((venue) => [venue.id, venue.name]));
}

function publicShape(photo: VenuePhoto, names: Map<number, string>) {
  return {
    id: photo.id,
    venueId: photo.venueId,
    venueName: names.get(photo.venueId) || `Venue #${photo.venueId}`,
    url: `/api/images/${photo.imageKey}`,
    caption: photo.caption,
    status: photo.status,
    // Why it's here: the model's own words, plus whether screening ran at all.
    moderation: photo.moderation,
    reviewNote: photo.reviewNote,
    createdAt: photo.createdAt,
  };
}

export const GET: APIRoute = async ({ cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  const names = venueNameById();
  const photos = await listVenuePhotosForReview();
  return json({ photos: photos.map((photo) => publicShape(photo, names)) });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const photo = await getVenuePhoto(cleanString(body.photoId));
  if (!photo) return errorJson(['Photo not found.'], 404);

  const action = cleanString(body.action);
  const note = cleanString(body.note).slice(0, 300);

  if (action === 'approve') {
    const updated = await updateVenuePhoto(photo.id, {
      status: 'published',
      reviewNote: note,
      reviewedBy: admin.email,
      markReviewed: true,
    });
    return json({ photo: updated && publicShape(updated, venueNameById()) });
  }

  if (action === 'reject') {
    // Kept as a row rather than deleted, so the owner's dashboard can show
    // that the photo was refused and why, instead of it silently disappearing.
    const updated = await updateVenuePhoto(photo.id, {
      status: 'rejected',
      reviewNote: note,
      reviewedBy: admin.email,
      markReviewed: true,
    });
    return json({ photo: updated && publicShape(updated, venueNameById()) });
  }

  if (action === 'delete') {
    // The escape hatch for something that shouldn't be retained at all. The
    // blob and its images row survive as the provenance trail; only the album
    // row goes.
    const deleted = await deleteVenuePhoto(photo.id);
    return json({ success: deleted });
  }

  return errorJson(['Action must be approve, reject, or delete.'], 400);
};
