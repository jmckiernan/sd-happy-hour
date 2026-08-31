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

/**
 * Should this venue's page be advertised in the sitemap?
 *
 * This is the exact complement of the `noindex` that VenueHappyHourPage puts on
 * the page, and it lives here so the two cannot drift apart. They had: the
 * sitemap filter excluded `unlisted` but not `seoHidden`, so 83 pages were
 * submitted to Google carrying a tag telling it not to index them — which
 * Search Console reports as an error, and which wastes crawl budget on listings
 * we had already decided to keep out of search.
 *
 * Note the sitemap is built with no knowledge of runtime claims, the same as
 * every other build-time caller, so it gets the static answer and catches up on
 * the deploy that clearance triggers.
 */
export function isSitemapEligible(venue: VisibilityInput & { seoHidden?: boolean }): boolean {
  return isPubliclyListed(venue) && !venue.seoHidden;
}

/**
 * Why a published venue is held back from browse.
 *
 * Each reason is a different situation wanting different handling and
 * different copy, which is why this is a named reason rather than a boolean.
 * Adding one means deciding what the surfaces should say about it.
 *
 * - `unverified_window` — we hold a happy-hour window we cannot source. No
 *   provenance for the times, or the pages we read describe another brand or
 *   another branch. The listing is an unverified claim, not a venue we have
 *   confirmed, and the fix is to scrape it or convert it to a claim stub.
 */
export const BROWSE_HOLD_REASONS = ['unverified_window'] as const;

export type BrowseHoldReason = (typeof BROWSE_HOLD_REASONS)[number];

export interface BrowseHold {
  reason: BrowseHoldReason;
  /** ISO date the hold was applied, so a stale hold can be spotted. */
  since: string;
  /** Free text for a hold that needs more than its reason to explain. */
  note?: string;
}

export interface BrowseInput {
  browseHold?: BrowseHold | null;
}

/**
 * Should this venue be kept off browse surfaces — the neighborhood pages, and
 * anywhere else navigation is gated?
 *
 * Deliberately not `seoHidden`. That flag means "keep this out of search
 * indexes": `noindex` on the venue page, out of the sitemap, out of the
 * homepage's ItemList. Reading it as a navigation flag as well is what left 83
 * published venues with real schedules unreachable, because a listing hidden
 * from Google for one reason was hidden from visitors for a different one that
 * nobody had stated. See docs/homepage-reachability.md.
 */
export function isHeldFromBrowse(venue: BrowseInput): boolean {
  return Boolean(venue.browseHold?.reason);
}

export function isBrowseHoldReason(value: unknown): value is BrowseHoldReason {
  return BROWSE_HOLD_REASONS.includes(value as BrowseHoldReason);
}
