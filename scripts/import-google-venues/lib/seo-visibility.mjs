import { isMultiTenantListing } from './window-only.mjs';

/**
 * Outcomes that say the pages we read describe somebody else — another brand's
 * site, or another branch of this one. A window quoted off those pages is not
 * evidence about this venue, so its provenance cannot be trusted.
 */
const MISATTRIBUTED_OUTCOMES = new Set(['wrong_website', 'other_location']);

/**
 * Have we confirmed this is a real place with a real happy-hour window?
 *
 * Three things have to hold, and deals are deliberately not among them.
 *
 * 1. The window is complete: days, a start and an end.
 * 2. The window has provenance — either a quote we read off the venue's own
 *    happy-hour page, or Google's `HAPPY_HOUR` secondary opening hours, which
 *    are times-only by construction and so can never bring a quote with them.
 * 3. Nothing we have since learned contradicts the attribution: the site we
 *    read was this venue's, describing this branch, and the listing is a venue
 *    rather than a building full of them.
 *
 * That is the whole question. Offers are content a confirmed venue may or may
 * not publish — `docs/window-only-listings.md` records the decision to keep
 * window-only listings published, because when happy hour runs is the thing
 * most visitors came for — so requiring them here would hide real venues for
 * failing a test about something else.
 */
export function hasConfirmedHappyHourWindow(venue) {
  if (!venue) return false;
  if (isMultiTenantListing(venue)) return false;
  if (!venue.startTime || !venue.endTime || !(venue.days || []).length) return false;

  const outcome = venue.lastScrape?.outcome;
  if (MISATTRIBUTED_OUTCOMES.has(outcome)) return false;

  const times = venue.hhSources?.times;
  if (!times) return false;
  if (times.source === 'google_places') return true;
  return (times.evidence || []).some((row) => row.quote && row.url);
}

/**
 * Whether a venue still deserves the `seoHidden` flag it was imported with.
 *
 * Imports set `seoHidden: true` whenever Google's happy hour answer was below
 * high confidence. Later work on the venue's own site can settle the question
 * the flag was hedging — is this a real, operating place whose happy hour we
 * can source — and once it has, the reason to hide the listing is gone.
 * `seoHidden` keeps a listing off the homepage index and every neighborhood
 * page, so leaving it set makes a published venue unreachable through the
 * site's own navigation.
 */
export function isVerifiedForIndexing(venue) {
  if (!venue || venue.listingStatus !== 'published') return false;
  return hasConfirmedHappyHourWindow(venue);
}
