import type { APIRoute } from 'astro';
import { validateListing } from '../../../../lib/validation';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../../lib/api';
import { updateVenue } from '../../../../lib/venueRepo';

export const prerender = false;

// Edits an already-published venue. The submission queue only covers listings
// on their way in; once approved, this is the way to correct one — same
// validation and the same commit-to-the-repo path as approval, so an edited
// venue can't end up in a shape approval would have rejected.
//
// Coordinates are required here for the same reason they are on approval:
// a live venue without them can't be placed on the homepage map.
export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return errorJson(['Invalid venue id.'], 400);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const { listing, errors } = validateListing(body.listing || {}, { requireCoordinates: true });
  if (errors.length) return errorJson(errors, 422);

  try {
    return json({ venue: await updateVenue(id, listing) });
  } catch (err: any) {
    // A missing id is the caller's problem; anything else is the repo write
    // failing (bad token, stale sha, GitHub down).
    const missing = /^No venue with id/.test(err.message);
    return errorJson([missing ? err.message : `Could not save venue: ${err.message}`], missing ? 404 : 502);
  }
};
