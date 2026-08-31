/**
 * Whether a venue still deserves the `seoHidden` flag it was imported with.
 *
 * Imports set `seoHidden: true` whenever Google's happy hour answer was below
 * high confidence. A later scrape of the venue's own site can settle the same
 * question properly, and once it has — a found outcome, high confidence, a real
 * window and real deal lines — the original reason to hide the listing is gone.
 * `seoHidden` keeps it off the homepage index and every neighborhood page, so
 * leaving it set makes a published venue effectively unreachable.
 */
export function isVerifiedForIndexing(venue) {
  if (!venue || venue.listingStatus !== 'published') return false;
  if (venue.lastScrape?.outcome !== 'found' || venue.lastScrape?.confidence !== 'high') return false;
  if (!venue.hasHappyHourData || venue.dealsUnknown) return false;
  if (!venue.startTime || !venue.endTime || !(venue.days || []).length) return false;
  return (venue.deals || []).length > 0;
}
