/**
 * The published listings that show a happy-hour window and nothing under it,
 * and the reason each one is in that state.
 *
 * Shared by the audit that counts them and the recovery that tries to fill
 * them, so both agree on what "empty" means and on which listings are not
 * worth reading a website for.
 */

import { looksLikeShoppingMall } from './venue-quality.mjs';
import { OUTCOME_LABELS } from './scrape-outcome.mjs';

/**
 * A quote that names money or a discount. Deliberately the same shape as
 * `OFFER_SIGNAL` in normalize.mjs: if this matches nothing across an entire
 * listing's stored evidence, no amount of re-reading that evidence will
 * produce an offer, and the listing is not recoverable from what we hold.
 */
export const PRICED_QUOTE = /\$\s?\d|\d+\s*%\s*off|[½¼⅓]|half[- ](?:off|price)|\bbogo\b|\b\d+\s+for\s+\$?\d|\bfree\b/i;

/**
 * A listing whose offers belong to its tenants rather than to itself.
 *
 * A food hall or public market publishes one happy-hour page covering a dozen
 * businesses, so anything read off it is some tenant's offer attributed to the
 * building. `looksLikeShoppingMall` catches the mall operators; this adds the
 * shapes San Diego actually has, and reads the scrape's own reason, which is
 * usually where the multi-tenant fact was first written down.
 */
export function isMultiTenantListing(venue = {}, scraped = null) {
  const observation = scraped || venue.lastScrape;
  if (looksLikeShoppingMall(venue, observation)) return true;
  const hay = `${venue.name || ''} ${observation?.reason || ''} ${observation?.notes || ''}`;
  if (!/\b(?:food hall|public market|marketplace|multi-?tenant|shopping cent(?:er|re))\b/i.test(hay)) return false;
  return !/\b(?:bar|grill|grille|restaurant|tavern|cantina|pub|brewery|kitchen)\b/i.test(String(venue.name || ''));
}

/** Every evidence row the listing holds, whichever field wrote it. */
export function allEvidence(venue) {
  return [
    ...(venue.lastScrape?.evidence || []),
    ...(venue.hhSources?.deals?.evidence || []),
    ...(venue.hhSources?.times?.evidence || []),
  ];
}

/**
 * Is this listing a window with nothing under it?
 *
 * Deals, a stored menu and a menu image are the three things a page can show a
 * visitor. `dealsUnknown` is deliberately not part of the test — it is the flag
 * we set when we believe the offers are missing, and the point here is to
 * measure the state of the page, not the state of the flag.
 */
export function isWindowOnly(venue) {
  return venue.listingStatus === 'published'
    && !(venue.deals || []).length
    && !(venue.hhMenu?.sections || []).length
    && !(venue.galleryImages || []).length;
}

/**
 * Where the window came from, which bounds what else could have come with it.
 *
 * `google_places` is Google's HAPPY_HOUR secondary opening hours: times only,
 * by construction. `none` is a window with no recorded provenance at all,
 * imported before the pipeline wrote `hhSources`. Only `website_hh_page` is a
 * source that could have carried offers and did not.
 */
export function windowSource(venue) {
  return venue.hhSources?.times?.source || (venue.lastScrape ? 'scrape_only' : 'none');
}

/**
 * The single reason this listing has no offers, most specific first.
 *
 * Ordered so that the bucket names an action. A listing we never asked about is
 * a different job from one whose website turned out to belong to another brand,
 * even though both end up as a bare window on the page.
 */
export function emptyCause(venue) {
  if (isMultiTenantListing(venue)) return 'not_a_venue';
  if (!venue.lastScrape) {
    return venue.hhSources?.deals ? 'never_scraped_with_sources' : 'never_scraped';
  }
  if (venue.lastScrape.outcome === 'found') return 'found_no_offers';
  return venue.lastScrape.outcome || 'unknown';
}

export const CAUSE_NOTES = {
  ...OUTCOME_LABELS,
  not_a_venue: 'Shopping centre, food hall or market — offers belong to tenants, not this listing',
  never_scraped: 'Never scraped for offers: no lastScrape, no evidence, no window provenance',
  never_scraped_with_sources: 'Window has sources but the deal scrape never ran',
  found_no_offers: 'Scrape found and quoted a window, but no offer text came with it',
};

/** Causes where the site we would read is known to be the wrong site. */
export const UNREADABLE_CAUSES = new Set(['wrong_website', 'other_location', 'not_a_venue']);
