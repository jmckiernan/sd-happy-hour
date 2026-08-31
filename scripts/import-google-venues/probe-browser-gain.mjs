#!/usr/bin/env node
// What the browser reads that a plain fetch does not.
//
// The menu re-scrape recorded 16 listings as "could not be re-read", which was
// never true: their sites render the menu in JavaScript, and the run simply did
// not pass `browserFetch`, so `createCachedFetch` detected an empty shell and
// had no browser to retry with. This fetches a set of listings both ways and
// reports the difference, so "unreadable" can be replaced with what the page
// actually says.
//
// No model calls: this compares the text each path recovers, which is enough to
// show whether a re-transcription would have anything to work with.
//
// Usage:
//   node scripts/import-google-venues/probe-browser-gain.mjs --ids=10,98,102
//   node scripts/import-google-venues/probe-browser-gain.mjs --unreadable

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { createCachedFetch } from './lib/fetch-page.mjs';
import { createBrowserFetch, hasBrowserState } from './lib/playwright-browser.mjs';
import { isUsableVenueWebsite } from './lib/website-ownership.mjs';

/** The 16 the re-scrape gave up on, by name, as recorded in the write-up. */
const UNREADABLE_NAMES = [
  'Herb & Wood',
  'STK Steakhouse',
  'Meze Greek Fusion',
  'Bencotto Italian Kitchen',
  "Eddie V's Prime Seafood",
  'Kettner Exchange',
  'Zama San Diego',
  'Lighthouse Oyster Bar & Grill',
  "Hapa J's",
  'Amalfi Cucina Italiana San Marcos',
  "Pal Joey's Cocktail Lounge",
  'Waverly',
  'California English',
  "Nick & G's Restaurant",
  'Red Tail Bar & Grill',
];

const idsArg = (process.argv.find((a) => a.startsWith('--ids=')) || '').split('=')[1];
const venues = readJson(HAPPY_HOURS_PATH, []);

let cohort;
if (idsArg) {
  const wanted = new Set(idsArg.split(',').map((s) => Number(s.trim())));
  cohort = venues.filter((v) => wanted.has(v.id));
} else {
  cohort = venues.filter((v) => UNREADABLE_NAMES.includes(v.name));
}
cohort = cohort.filter((v) => isUsableVenueWebsite(v.hhMenu?.sourceUrl || v.website));

if (!hasBrowserState()) {
  console.error('No warmed browser profile. Run: npm run browser:warm -- --auto');
  process.exit(1);
}

const HH = /happy\s*hour|golden\s*hour|social\s*hour|late\s*night|drink specials?/i;
const PRICE = /\$\s?\d/g;

function summarize(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return {
    length: clean.length,
    mentionsHappyHour: HH.test(clean),
    priceCount: (clean.match(PRICE) || []).length,
  };
}

const plainOnly = createCachedFetch({ refresh: true });
const browserSession = await createBrowserFetch({});
const withBrowser = createCachedFetch({
  browserFetch: browserSession.fetch,
  refresh: true,
  browserConcurrency: 2,
});

console.log(`Reading ${cohort.length} listing(s) both ways.\n`);
const rows = [];

for (const venue of cohort) {
  const url = venue.hhMenu?.sourceUrl || venue.website;
  let plain = { length: 0, mentionsHappyHour: false, priceCount: 0 };
  let browser = { length: 0, mentionsHappyHour: false, priceCount: 0 };
  try {
    plain = summarize(await (await plainOnly(url)).visibleText());
  } catch {
    // recorded as a zero-length read
  }
  try {
    browser = summarize(await (await withBrowser(url)).visibleText());
  } catch {
    // recorded as a zero-length read
  }
  const gained = browser.length - plain.length;
  rows.push({ id: venue.id, name: venue.name, url, plain, browser, gained });
  const verdict = browser.mentionsHappyHour && browser.priceCount > 0
    ? 'happy hour with prices'
    : browser.mentionsHappyHour
      ? 'happy hour named, no prices'
      : browser.length > plain.length * 2
        ? 'page readable, no happy hour on it'
        : 'no better';
  console.log(
    `  ${String(venue.id).padStart(4)} ${venue.name.slice(0, 34).padEnd(34)} `
    + `plain ${String(plain.length).padStart(6)} → browser ${String(browser.length).padStart(6)} `
    + `(${browser.priceCount} prices)  ${verdict}`
  );
}

await browserSession.close();

const better = rows.filter((r) => r.browser.length > r.plain.length * 2);
const withHh = rows.filter((r) => r.browser.mentionsHappyHour && r.browser.priceCount > 0);
console.log('\n--- result ---');
console.log(`  listings read:                       ${rows.length}`);
console.log(`  browser recovered materially more:   ${better.length}`);
console.log(`  ...of which name a happy hour with prices: ${withHh.length}`);
console.log(`  no better either way:                ${rows.length - better.length}`);

writeJson('.data/browser-gain.json', { ranAt: new Date().toISOString(), rows });
console.log('\nWrote .data/browser-gain.json');
