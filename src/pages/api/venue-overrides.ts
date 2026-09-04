import type { APIRoute } from 'astro';
import { getVenueOverrides, listPublishedVenueIds, listVerifiedClaimedVenueIds } from '../../lib/store';
import { getVenues } from '../../lib/venues';
import { LIVE_LISTING_FIELDS, mergeVenue, resolveLiveFeaturedImage } from '../../lib/venueContent';

export const prerender = false;

// Public, unauthenticated: every venue's owner edits in one response, keyed by
// venue id, for the pages that render the whole venue set client-side (the
// homepage grid and list pages). Those fetch the static /data/happy-hours.json and
// merge this over it, so an owner's corrected hours show up there as well as on
// the venue page — otherwise the card and the venue page would disagree.
//
// Only venues an owner has actually edited appear here, so this stays small:
// no row means "nothing to merge".
//
// `publishedVenueIds` rides along because it answers a question the static
// file can't: which unlisted venues have since been cleared for the public
// site by a verified claim, and so should be visible right now rather than
// after the next deploy. See lib/listingVisibility.ts.
//
// Filtered to LIVE_LISTING_FIELDS on the way out rather than trusting the
// stored patch. The patch is written through validateOwnerPatch(), or as an
// admin's field-level delta, and so should only ever contain those keys, but
// this response gets spread straight over a venue object in the browser — a
// stray key from an older patch shape would silently overwrite something it
// shouldn't.
//
// Featured photos are resolved here — same as /api/venue-content — so a stale
// override pointing at a deleted Blob cannot clobber a healthy catalog image on
// homepage cards while the venue page quietly falls back.
export const GET: APIRoute = async () => {
  const [overrides, publishedVenueIds, ownerVerifiedVenueIds] = await Promise.all([
    getVenueOverrides(),
    listPublishedVenueIds(),
    listVerifiedClaimedVenueIds(),
  ]);

  const venuesById = new Map(getVenues().map((venue) => [venue.id, venue]));
  const payload: Record<string, Record<string, unknown>> = {};

  for (const [venueId, override] of Object.entries(overrides)) {
    const patch: Record<string, unknown> = {};
    for (const field of LIVE_LISTING_FIELDS) {
      if (field in override.patch) patch[field] = override.patch[field];
    }

    const touchesImage =
      Object.prototype.hasOwnProperty.call(override.patch, 'image') ||
      Object.prototype.hasOwnProperty.call(override.patch, 'imageCrop');
    const venue = venuesById.get(Number(venueId));
    if (venue && touchesImage) {
      const merged = mergeVenue(venue, override);
      const featured = await resolveLiveFeaturedImage(venue, merged, override);
      patch.image = featured.image;
      patch.imageCrop = featured.imageCrop ?? null;
    }

    payload[venueId] = patch;
  }

  return new Response(JSON.stringify({
    overrides: payload,
    publishedVenueIds: [...publishedVenueIds],
    ownerVerifiedVenueIds: [...ownerVerifiedVenueIds],
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Homepage cards use this as their live layer over static JSON, so an
      // editor save must not be hidden behind an edge/SWR cache.
      'cache-control': 'no-store',
      'netlify-cdn-cache-control': 'no-store',
    },
  });
};
