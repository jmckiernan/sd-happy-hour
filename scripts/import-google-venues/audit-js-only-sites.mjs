#!/usr/bin/env node
// How many listings look empty because we read their site with the wrong tool.
//
// `createCachedFetch` already knows how to handle a JavaScript-only site: it
// plain-fetches, and when `needsBrowser()` says the response is an empty shell
// — an SPA menu host, a Popmenu page with no prices, under 500 characters of
// text — it retries through Playwright. But that retry is guarded by
// `gatedBrowser`, which is null unless the caller passed `browserFetch`. So a
// caller that omits it gets the detection and none of the remedy: the fetch
// returns 200, the page is blank, and every downstream step treats an empty
// answer as a truthful one. That is how 16 venues in the menu re-scrape were
// recorded as "could not be re-read" when the tool to read them existed.
//
// This measures the size of that blind spot. For every listing we actually
// scraped and came away empty-handed from, the site is plain-fetched again and
// the same `needsBrowser()` predicate applied. A venue it flags is one whose
// emptiness is unexplained by the evidence — it may have a happy hour we never
// saw. No model calls and no browser: this only needs to know which pages the
// cheap path cannot read.
//
// Usage:
//   node scripts/import-google-venues/audit-js-only-sites.mjs
//   node scripts/import-google-venues/audit-js-only-sites.mjs --limit=50

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { pageNeedsBrowser, mapPool } from './lib/fetch-page.mjs';
import { isUsableVenueWebsite } from './lib/website-ownership.mjs';

const REPORT_PATH = process.argv.includes('--never-scraped')
  ? '.data/js-only-sites-never-scraped.json'
  : '.data/js-only-sites.json';
const limitArg = (process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1];
const limit = limitArg ? Number(limitArg) : Infinity;

const venues = readJson(HAPPY_HOURS_PATH, []);

/**
 * Listings whose emptiness we would have to explain.
 *
 * Deliberately excludes the 2,396 with no `lastScrape` at all — those are
 * claimable stubs imported from Google whose sites were never read, so they are
 * not miscategorised, merely unattempted. It also excludes the outcomes that
 * carry their own explanation: `wrong_website` and `other_location` mean we
 * found a page and rejected it on the evidence, which is a different and
 * correct answer.
 */
const UNEXPLAINED_OUTCOMES = new Set(['no_candidates', 'extract_failed', 'found']);

function isUnexplainedEmpty(venue) {
  const outcome = venue.lastScrape?.outcome;
  if (!outcome || !UNEXPLAINED_OUTCOMES.has(outcome)) return false;
  const hasMenu = Boolean(venue.hhMenu?.sections?.length);
  const hasDeals = Boolean((venue.deals || []).length);
  if (outcome !== 'found') return true;
  // Read successfully, but came away with no menu or no offers.
  return !hasMenu || !hasDeals || Boolean(venue.dealsUnknown);
}

/**
 * The other half of the question. These have no `lastScrape` at all — imported
 * from Google and never read — so they are recorded as having no happy hour on
 * no evidence whatsoever. The browser was never the problem here because no
 * fetch was ever made, but the rate of unreadable sites in this population is
 * what a full scrape would run into, and it converts "we never looked" into a
 * number of venues a plain-fetch scrape would silently get wrong.
 */
const neverScraped = process.argv.includes('--never-scraped');
let cohort = neverScraped
  ? venues.filter((v) => !v.lastScrape?.outcome && isUsableVenueWebsite(v.website))
  : venues.filter((v) => isUnexplainedEmpty(v) && isUsableVenueWebsite(v.website));

// Sampling is honest here: we want the rate, and a rate does not need all 2,181.
if (neverScraped && Number.isFinite(limit)) {
  const stride = Math.max(1, Math.floor(cohort.length / limit));
  cohort = cohort.filter((_, i) => i % stride === 0).slice(0, limit);
}
cohort = Number.isFinite(limit) ? cohort.slice(0, limit) : cohort;

console.log(
  neverScraped
    ? `Fetching ${cohort.length} listing(s) that were never read at all, to measure the rate.\n`
    : `Re-fetching ${cohort.length} listing(s) whose emptiness is unexplained.\n`
);

const rows = await mapPool(cohort, 6, async (venue) => {
  const verdict = await pageNeedsBrowser(venue.website);
  return { venue, ...verdict };
});

const flagged = rows.filter((r) => r.needsBrowser);
const readable = rows.filter((r) => !r.needsBrowser);

const byReason = new Map();
for (const row of flagged) {
  byReason.set(row.reason, (byReason.get(row.reason) || 0) + 1);
}

console.log('--- result ---');
console.log(`  cohort:                              ${rows.length}`);
console.log(`  plain fetch cannot read the site:    ${flagged.length}`);
console.log(`  plain fetch reads it fine:           ${readable.length}`);
console.log('\n  why the cheap path fails:');
for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(reason).padEnd(22)} ${n}`);
}

console.log('\n  first 15 flagged:');
for (const row of flagged.slice(0, 15)) {
  console.log(`    ${row.venue.id} ${row.venue.name} — ${row.reason} (${row.venue.website})`);
}

writeJson(REPORT_PATH, {
  ranAt: new Date().toISOString(),
  cohortSize: rows.length,
  needsBrowser: flagged.length,
  byReason: Object.fromEntries(byReason),
  venues: flagged.map((r) => ({
    id: r.venue.id,
    name: r.venue.name,
    website: r.venue.website,
    reason: r.reason,
    textLength: r.textLength,
    outcome: r.venue.lastScrape?.outcome || null,
    hasMenu: Boolean(r.venue.hhMenu?.sections?.length),
    deals: (r.venue.deals || []).length,
  })),
});
console.log(`\nWrote ${REPORT_PATH}`);
