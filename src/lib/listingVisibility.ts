// Who reaches the public site, and why.
//
// Kept free of imports for the same reason as lib/listingCopy.ts: the browser
// bundles this, and lib/venues.ts drags public/data/happy-hours.json along.
//
// Two independent signals can publish a venue:
//
//   1. `listingStatus` in the venue file — the data pipeline could substantiate
//      a happy hour from Google or the venue's own site, so it publishes on its
//      own evidence with no human in the loop.
//   2. A publication record — the venue was cleared by an owner proving they
//      run it (an email on the venue's domain, or a code texted to its listed
//      number), or by an admin reviewing a manually submitted claim. See
//      migrations/0017_venue_publications.sql.
//
// The second signal is evaluated at runtime so clearance takes effect
// immediately rather than waiting for the next deploy.

export interface VisibilityInput {
  listingStatus?: 'published' | 'unlisted';
  id?: number;
}

/**
 * Should this venue appear on public browse surfaces?
 *
 * `publishedVenueIds` comes from /api/venue-overrides at runtime. Callers that
 * can't know it — prerendered pages and the sitemap, built before any of
 * today's clearances happened — pass nothing and get the static answer; they
 * catch up on the deploy that clearance triggers.
 *
 * Venues predating `listingStatus` are treated as published, so this could be
 * rolled out without backfilling every row first.
 */
export function isPubliclyListed(
  venue: VisibilityInput,
  publishedVenueIds?: ReadonlySet<number> | null
): boolean {
  if (venue.listingStatus !== 'unlisted') return true;
  return Boolean(venue.id != null && publishedVenueIds?.has(venue.id));
}
