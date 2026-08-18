import type { APIRoute } from 'astro';
import { getVenues } from '../../../../../lib/venues';
import { getVenueOverride, setVenueOverride, listPublishedVenuePhotos } from '../../../../../lib/store';
import { getVenueManager, NOT_A_MANAGER_MESSAGE } from '../../../../../lib/venueManager';
import { mergeVenue, validateOwnerPatch, OWNER_EDITABLE_FIELDS } from '../../../../../lib/venueContent';
import { json, errorJson, readJsonBody } from '../../../../../lib/api';

export const prerender = false;

// A verified claimant editing their own listing.
//
// Unlike the admin equivalent (api/admin/venues/[id].ts), this does NOT commit
// to public/data/happy-hours.json. Owner edits are stored as a patch in
// venue_overrides and merged at read time, which means they're live
// immediately rather than on the next deploy, and owner-supplied text never
// lands in a repo commit. See src/lib/venueContent.ts for the merge and for
// why only some fields are editable here.

function findVenue(id: number) {
  return getVenues().find((venue) => venue.id === id);
}

export const GET: APIRoute = async ({ params, cookies }) => {
  const venueId = Number(params.id);
  if (!Number.isInteger(venueId) || venueId <= 0) return errorJson(['Invalid venue id.'], 400);

  const manager = await getVenueManager(cookies, venueId);
  if (!manager) return errorJson([NOT_A_MANAGER_MESSAGE], 403);

  const venue = findVenue(venueId);
  if (!venue) return errorJson(['Venue not found.'], 404);

  const override = await getVenueOverride(venueId);

  return json({
    // The merged listing is what the owner should be editing — starting them
    // from the base record would silently revert their last save.
    listing: mergeVenue(venue, override),
    editableFields: OWNER_EDITABLE_FIELDS,
    hasOverride: Boolean(override),
    updatedAt: override?.updatedAt ?? null,
    // The featured photo can only be one of their cleared album photos, so the
    // dashboard needs the list to build that picker.
    photoOptions: (await listPublishedVenuePhotos(venueId)).map((photo) => ({
      id: photo.id,
      url: `/api/images/${photo.imageKey}`,
      caption: photo.caption,
    })),
  });
};

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const venueId = Number(params.id);
  if (!Number.isInteger(venueId) || venueId <= 0) return errorJson(['Invalid venue id.'], 400);

  const manager = await getVenueManager(cookies, venueId);
  if (!manager) return errorJson([NOT_A_MANAGER_MESSAGE], 403);

  const venue = findVenue(venueId);
  if (!venue) return errorJson(['Venue not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const { patch, errors } = validateOwnerPatch(body.listing || {});
  if (errors.length) return errorJson(errors, 422);

  // The featured photo has to be one of this venue's published photos.
  // validateOwnerPatch only checked the URL shape; this is the check that
  // stops an owner pointing it at an arbitrary stored image — including one
  // of their own photos that screening is still holding, or another venue's.
  const image = String(patch.image || '');
  if (image) {
    const published = await listPublishedVenuePhotos(venueId);
    const allowed = published.some((photo) => `/api/images/${photo.imageKey}` === image);
    if (!allowed) {
      return errorJson(
        ['Choose a featured photo from your own approved photos. A photo still in review can’t be featured yet.'],
        422
      );
    }
  }

  const override = await setVenueOverride(venueId, patch, manager.user.id);
  return json({ listing: mergeVenue(venue, override), updatedAt: override.updatedAt });
};
