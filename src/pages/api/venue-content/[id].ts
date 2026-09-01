import type { APIRoute } from 'astro';
import { getVenues } from '../../../lib/venues';
import { getVenueOverride, isVenueOwnerVerified } from '../../../lib/store';
import { getVenueContent, mergeVenue, LIVE_LISTING_FIELDS } from '../../../lib/venueContent';
import { json, errorJson } from '../../../lib/api';

export const prerender = false;

// Public, unauthenticated: everything the venue page needs that isn't baked
// into its static HTML — live owner/admin listing edits, the photo album, and
// the menu.
//
// The venue page is prerendered from happy-hours.json at build time, so an
// those changes would otherwise wait for a deploy. Fetching this on load lets
// runtime-managed content appear immediately while the page itself stays
// static and CDN-cached.
//
// Only published photos are ever included (listPublishedVenuePhotos), so an
// unscreened photo can't reach a visitor even if the id is guessed.
export const GET: APIRoute = async ({ params }) => {
  const venueId = Number(params.id);
  if (!Number.isInteger(venueId) || venueId <= 0) return errorJson(['Invalid venue id.'], 400);

  const venue = getVenues().find((entry) => entry.id === venueId);
  if (!venue) return errorJson(['Venue not found.'], 404);

  const [override, content, ownerVerified] = await Promise.all([
    getVenueOverride(venueId),
    getVenueContent(venueId),
    isVenueOwnerVerified(venueId),
  ]);
  const merged = mergeVenue(venue, override);

  // Only the live-editable fields go back, not the whole venue: the page
  // already has the rest in its HTML, and this keeps the response about what
  // can actually have changed since the build.
  const listing: Record<string, unknown> = {};
  const mergedFields = merged as unknown as Record<string, unknown>;
  for (const field of LIVE_LISTING_FIELDS) listing[field] = mergedFields[field];

  return new Response(
    JSON.stringify({
      venueId,
      ownerVerified,
      listing,
      hasOwnerEdits: Boolean(override),
      photos: content.photos,
      menu: content.menu,
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // This response is the runtime overlay for a prerendered page. Caching
        // it would make a successful admin/owner save appear stale for up to
        // the SWR window, which violates the editor's live-update contract.
        'cache-control': 'no-store',
        'netlify-cdn-cache-control': 'no-store',
      },
    }
  );
};
