import { fetchVenues, commitVenues } from './venueRepo';
import { publishVenue, unpublishVenue, type VenuePublicationSource } from './store';

// Putting a venue on the public site that our own data couldn't justify.
//
// Venues the pipeline could substantiate carry listingStatus 'published' in
// happy-hours.json and never come through here. This is the other route: an
// owner turned up and proved they run the place, which outranks whatever we
// could or couldn't scrape.
//
// Three routes lead here, and they differ only in who did the proving:
//
//   domain — claimant's email is on the venue's own domain (api/restaurant/claim)
//   phone  — claimant entered a code texted to the venue's listed number
//            (api/restaurant/claim/verify-code)
//   admin  — someone here approved a manually submitted claim
//            (api/admin/restaurants/[id])
//
// The first two publish immediately without waiting for a human. Only manual
// claims sit in the review queue.
//
// Each clearance is written twice, because visibility has two layers:
//
//   1. venue_publications in the database, which /api/venue-overrides reports
//      on every public page load — this is what makes it take effect at once.
//   2. listingStatus in happy-hours.json, which the prerendered neighbourhood
//      pages, the sitemap, and the venue page's noindex tag are built from,
//      and which stops the next backfill run from undoing the decision.

/**
 * Clear a venue for the public site.
 *
 * The database write is the one that matters and is awaited; the venue-file
 * commit is best-effort. A GitHub outage or a missing token in development
 * must not fail a claim the caller has already verified — the runtime layer
 * keeps the venue visible either way, and only the SEO surfaces lag until a
 * later write succeeds.
 */
export async function publishVerifiedVenue(
  venueId: number,
  source: VenuePublicationSource,
  userId: string | null,
  note = ''
): Promise<void> {
  await publishVenue(venueId, source, userId, note);
  await commitListingStatus(venueId, 'published');
}

/** Reverse of publishVerifiedVenue, for an admin taking a venue back down. */
export async function unpublishVenueEverywhere(venueId: number): Promise<void> {
  await unpublishVenue(venueId);
  await commitListingStatus(venueId, 'unlisted');
}

/** Returns whether a commit was made. Never throws. */
async function commitListingStatus(
  venueId: number,
  status: 'published' | 'unlisted'
): Promise<boolean> {
  try {
    const { venues, sha } = await fetchVenues();
    const index = venues.findIndex((venue) => Number(venue.id) === venueId);
    if (index === -1) return false;

    const venue = venues[index];
    if (status === 'published') {
      // Already visible on its own evidence — nothing to record, and no reason
      // to mark it as owner-published.
      if (venue.listingStatus !== 'unlisted') return false;
      venues[index] = { ...venue, listingStatus: 'published', publishedByClaim: true };
    } else {
      // Only take down venues that were published by clearance. One the data
      // pipeline substantiated isn't this function's to hide; that's a data
      // question, handled by the backfill.
      if (!venue.publishedByClaim) return false;
      venues[index] = { ...venue, listingStatus: 'unlisted', publishedByClaim: false };
    }

    const verb = status === 'published' ? 'Publish' : 'Unpublish';
    await commitVenues(venues, sha, `${verb} venue: ${venue.name}`);
    return true;
  } catch (err) {
    console.error(`Could not set listingStatus=${status} for venue ${venueId}:`, err);
    return false;
  }
}
