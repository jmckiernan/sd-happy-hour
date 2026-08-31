#!/usr/bin/env node
// Why does a published listing carry a happy-hour window and nothing else?
//
// 42% of published listings are in that state, and "re-scrape them" is only the
// right answer for some of them. This script sorts them by the reason the
// offers are missing, using nothing but what the catalog already stores: the
// window's own provenance, the outcome and evidence of the last scrape, and
// whatever media hangs off the listing. No network, no API calls.
//
// The two questions it answers, in order of how much they change what to build:
//
//   1. Where did the window come from? A window read out of Google's
//      HAPPY_HOUR secondary hours can never have brought offers with it —
//      Google publishes the times and nothing else — so those listings are not
//      a failed extraction, they are a listing built from a source that does
//      not carry the content.
//   2. For the listings we did read a website for, what happened? A site that
//      publishes no offers is a different problem from one we fetched under the
//      wrong brand, and only one of them is worth re-scraping.
//
// Usage:
//   npm run audit:empty-listings
//   npm run audit:empty-listings -- --ids     # print the ids in each bucket

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson } from './lib/io.mjs';
import { OUTCOME_LABELS } from './lib/scrape-outcome.mjs';
import { looksLikeShoppingMall } from './lib/venue-quality.mjs';

/**
 * A quote that names money or a discount. Deliberately the same shape as
 * `OFFER_SIGNAL` in lib/normalize.mjs: if this matches nothing across an
 * entire listing's stored evidence, no amount of re-reading that evidence will
 * produce an offer, and the listing is not recoverable from what we hold.
 */
export const PRICED_QUOTE = /\$\s?\d|\d+\s*%\s*off|[½¼⅓]|half[- ](?:off|price)|\bbogo\b|\b\d+\s+for\s+\$?\d|\bfree\b/i;

const PDF_URL = /\.pdf(?:\?|#|$)/i;

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
 * visitor. `dealsUnknown` is deliberately not part of the test — it is the
 * flag we set when we believe the offers are missing, and the point here is to
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
  if (looksLikeShoppingMall(venue)) return 'not_a_venue';
  if (!venue.lastScrape) {
    return venue.hhSources?.deals ? 'never_scraped_with_sources' : 'never_scraped';
  }
  if (venue.lastScrape.outcome === 'found') return 'found_no_offers';
  return venue.lastScrape.outcome || 'unknown';
}

const CAUSE_NOTES = {
  ...OUTCOME_LABELS,
  not_a_venue: 'Shopping centre or food hall — offers belong to tenants, not this listing',
  never_scraped: 'Never scraped for offers: no lastScrape, no evidence, no window provenance',
  never_scraped_with_sources: 'Window has sources but the deal scrape never ran',
  found_no_offers: 'Scrape found and quoted a window, but no offer text came with it',
};

const venues = readJson(HAPPY_HOURS_PATH, []);
const showIds = process.argv.includes('--ids');
const published = venues.filter((venue) => venue.listingStatus === 'published');
const empty = published.filter(isWindowOnly);

const byCause = new Map();
const bySource = new Map();
const recoverable = { pricedQuote: [], pdfCandidate: [], menuCandidateImage: [] };

for (const venue of empty) {
  const cause = emptyCause(venue);
  if (!byCause.has(cause)) byCause.set(cause, []);
  byCause.get(cause).push(venue);

  const source = windowSource(venue);
  bySource.set(source, (bySource.get(source) || 0) + 1);

  if (allEvidence(venue).some((row) => PRICED_QUOTE.test(row.quote || ''))) {
    recoverable.pricedQuote.push(venue);
  }
  if ((venue.lastScrape?.candidateUrls || []).some((url) => PDF_URL.test(url))) {
    recoverable.pdfCandidate.push(venue);
  }
  if ((venue.menuCandidateImages || []).length) recoverable.menuCandidateImage.push(venue);
}

const pct = (count) => `${((count / empty.length) * 100).toFixed(0)}%`;

console.log(`${venues.length} listings, ${published.length} published.`);
console.log(`${empty.length} published listings are a window and nothing else `
  + `(${((empty.length / published.length) * 100).toFixed(0)}% of published).\n`);

console.log('Where the window came from — bounds what could have come with it:');
for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${pct(count).padStart(4)}  ${source}`);
}

console.log('\nWhy the offers are missing:');
for (const [cause, list] of [...byCause].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(list.length).padStart(4)}  ${pct(list.length).padStart(4)}  ${cause} — ${CAUSE_NOTES[cause] || ''}`);
  if (showIds) console.log(`        ${list.map((venue) => venue.id).join(' ')}`);
}

console.log('\nEvidence we already hold that could yield an offer:');
for (const [name, list] of Object.entries(recoverable)) {
  console.log(`  ${String(list.length).padStart(4)}  ${name}`);
  for (const venue of list) {
    const quote = allEvidence(venue).find((row) => PRICED_QUOTE.test(row.quote || ''));
    const detail = name === 'pricedQuote'
      ? `${venue.lastScrape?.locationApplicability || 'unspecified'} — ${String(quote?.quote || '').slice(0, 90)}`
      : '';
    console.log(`        ${venue.name} (${venue.id}) ${detail}`);
  }
}

const noEvidence = empty.filter((venue) => !allEvidence(venue).length);
console.log(`\n${noEvidence.length} of the ${empty.length} hold no evidence quote of any kind, `
  + 'so nothing can be recovered from the catalog itself.');
