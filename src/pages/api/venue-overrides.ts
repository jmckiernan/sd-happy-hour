import type { APIRoute } from 'astro';
import { getVenueOverrides } from '../../lib/store';
import { OWNER_EDITABLE_FIELDS } from '../../lib/venueContent';

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
// Filtered to OWNER_EDITABLE_FIELDS on the way out rather than trusting the
// stored patch. The patch is written through validateOwnerPatch() and so should
// only ever contain those keys, but this response gets spread straight over a
// venue object in the browser — a stray key from an older patch shape would
// silently overwrite something it shouldn't.
export const GET: APIRoute = async () => {
  const overrides = await getVenueOverrides();

  const payload: Record<string, Record<string, unknown>> = {};
  for (const [venueId, override] of Object.entries(overrides)) {
    const patch: Record<string, unknown> = {};
    for (const field of OWNER_EDITABLE_FIELDS) {
      if (field in override.patch) patch[field] = override.patch[field];
    }
    payload[venueId] = patch;
  }

  return new Response(JSON.stringify({ overrides: payload }), {
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
