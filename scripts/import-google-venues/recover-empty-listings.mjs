#!/usr/bin/env node
// Try to recover offers for the published listings that show a window and
// nothing else, using the free path only: fetch the venue's own pages, read
// the happy-hour section with the regex extractor, keep the lines that name a
// price. No model call, no Google call.
//
// The rule the whole script exists to enforce: **a recovered line is quoted,
// never inferred.** A wrong price on a venue page is worse than no price at
// all, because a visitor acts on it. So a line is only accepted when
//
//   * it survives `stripNonOffers`, the same filter the import path uses, and
//   * it names an amount or a discount in its own words, and
//   * it came out of a happy-hour section on a page that corroborates *this*
//     venue, not a sibling branch.
//
// The quote is stored beside the deal as `hhSources.deals.evidence`, so every
// recovered chip can be re-checked against the sentence it came from.
//
// Listings whose last scrape landed on the wrong brand or another branch are
// skipped rather than re-read: their website is known to be the wrong website,
// so anything found there would be someone else's offer.
//
// **Nothing is written without an id on the command line.** The filters above
// keep a line from being invented, but they cannot tell a happy-hour price from
// a regular one: the first pass over the catalog proposed a $20 corkage fee and
// a 6 oz chicken at $7 as happy-hour deals, both quoted perfectly accurately
// off the venue's own menu page. So the crawl proposes and a human approves,
// and the approved ids are the record of who decided.
//
// Usage:
//   npm run recover:empty-listings                        # propose only
//   npm run recover:empty-listings -- --approve=161,243   # write those two
//   npm run recover:empty-listings -- --limit=25

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { finalizeDeals } from './lib/deals.mjs';
import { extractWebsiteHappyHourDeep } from './lib/happy-hour.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { conflictsWithVenue } from './lib/location-page.mjs';
import { inferDealTypes, stripNonOffers } from './lib/normalize.mjs';
import { UNREADABLE_CAUSES, emptyCause, isWindowOnly } from './lib/window-only.mjs';

const PROPOSALS_PATH = '.data/import/empty-recovery-proposals.json';

/**
 * Does this line quote money in the venue's own words?
 *
 * Stricter than the import path's `OFFER_SIGNAL` on purpose. That filter runs
 * over text a model already judged to be offers; this one runs over raw page
 * lines, where the only thing standing between "Free wifi" and a deal chip is
 * this regex.
 */
const NAMES_A_PRICE = /\$\s?\d|\d+\s*%\s*off|[½¼⅓]|half[- ](?:off|price)|\b1\/2\s*(?:off|price)\b|\bbogo\b|\b\d+\s+for\s+\$?\d|\bfree\b/i;

/** "Free" that is an amenity, not something you can order. */
const NOT_AN_OFFER_FREE = /\bfree\s+(?:wi-?fi|parking|wifi|delivery|shipping|estimate|consultation|trial|of charge)\b/i;

/**
 * A price the customer pays extra, not less: corkage, cake and dessert fees,
 * service charges, per-person minimums. These read exactly like offers — a
 * dollar amount against a noun — and the first pass proposed three of them.
 */
const A_CHARGE_NOT_AN_OFFER = /\b(?:corkage|cake(?:age)?|dessert|service|split|delivery|cleaning|per[- ]person)\s+fee\b|\bfee\s+(?:of|per)\b|\bgratuity\b|\bminimum\b|\bsurcharge\b|\bvalet\b|\bparking\b|\bmembership\b|\bper month\b|\bevery (?:other )?month\b/i;

/** A currency reading with nothing bought: "$50.00 USD", a total, a balance. */
const NOT_AN_ITEM = /^\$\s?\d[\d.,]*\s*(?:usd)?$/i;

/** A full-price upgrade on a regular dish: "add steak $15". */
const AN_UPCHARGE = /^add\b|\badd\s+\w+\s+\$\d/i;

/**
 * A banner or nav strip, which is a list of section names with prices in it
 * rather than an offer: "51% OFF HAPPY HOUR • PADRES PRE-GAME • PRIVATE EVENTS".
 */
const A_BANNER_STRIP = /(?:[•✰✦].*){2,}/;

export function acceptableOffers(rawDeals, venue) {
  const nameTokens = String(venue.name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);

  return stripNonOffers(rawDeals || [], venue.name)
    .filter((line) => NAMES_A_PRICE.test(line))
    .filter((line) => !NOT_AN_OFFER_FREE.test(line))
    .filter((line) => !A_CHARGE_NOT_AN_OFFER.test(line))
    .filter((line) => !NOT_AN_ITEM.test(line))
    .filter((line) => !AN_UPCHARGE.test(line))
    .filter((line) => !A_BANNER_STRIP.test(line))
    // `stripNonOffers` lets a line that echoes the venue's own name through
    // once it quotes a price, but a priced line naming the venue is usually a
    // page title ("at Mavericks HALF OFF ALL DRINKS! - Mavericks Beach Club").
    // Two tokens, not one: a pizzeria discounts pizzas and a taqueria discounts
    // tacos, and one word of the venue's name in an offer is the offer.
    .filter((line) => {
      const lower = line.toLowerCase();
      return nameTokens.filter((token) => lower.includes(token)).length < 2;
    });
}

function parseIdList(argv, flag) {
  const arg = argv.find((value) => value.startsWith(flag));
  if (!arg) return null;
  const ids = arg
    .slice(flag.length)
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);
  return new Set(ids);
}

/**
 * Write the approved proposals onto the catalog.
 *
 * Re-reads at write time and merges by id: other agents write this file, and a
 * crawl that takes half an hour must not post a stale copy of everything else
 * over the top of their work.
 */
function applyApproved(recovered, approved) {
  const current = readJson(HAPPY_HOURS_PATH, []);
  const byId = new Map(current.map((venue) => [venue.id, venue]));
  const observedAt = new Date().toISOString().slice(0, 10);
  let written = 0;

  for (const row of recovered) {
    if (!approved.has(row.id)) continue;
    const target = byId.get(row.id);
    if (!target || (target.deals || []).length) continue;
    target.deals = row.deals;
    target.dealsUnknown = false;
    target.dealTypes = inferDealTypes(row.deals, target);
    target.hhSources = {
      ...(target.hhSources || {}),
      deals: {
        source: 'website_hh_page',
        url: row.sourcePage,
        observedAt,
        evidence: row.deals.map((deal) => ({ url: row.sourcePage, quote: deal, field: 'deals' })),
      },
    };
    written += 1;
    console.log(`  = ${target.name} (${target.id}) ${row.deals.join(' · ')}`);
  }

  writeJson(HAPPY_HOURS_PATH, current);
  console.log(`Wrote offers onto ${written} listing(s) in ${HAPPY_HOURS_PATH}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const approved = parseIdList(process.argv.slice(2), '--approve=');

  // Approving from the saved proposal costs no fetches, which matters: the
  // crawl takes about forty minutes and reviewing it takes longer than that.
  if (process.argv.includes('--from-proposals')) {
    const proposals = readJson(PROPOSALS_PATH, []);
    if (!proposals.length) throw new Error(`No proposals in ${PROPOSALS_PATH} — run the crawl first.`);
    if (!approved?.size) throw new Error('Pass --approve=<ids> with --from-proposals.');
    applyApproved(proposals, approved);
    return;
  }

  const venues = readJson(HAPPY_HOURS_PATH, []);

  // `--only` re-reads a named handful, for when a filter changed and re-running
  // the whole catalog would cost another forty minutes of fetching.
  const only = parseIdList(process.argv.slice(2), '--only=');
  const todo = venues
    .filter((venue) => isWindowOnly(venue) && venue.website && !UNREADABLE_CAUSES.has(emptyCause(venue)))
    .filter((venue) => !only || only.has(venue.id));
  const batch = options.limit ? todo.slice(0, options.limit) : todo;

  console.log(`${todo.length} window-only listings are worth re-reading; trying ${batch.length}.`);
  console.log(approved
    ? `Writing the ${approved.size} approved listing(s); proposing the rest.\n`
    : 'Proposal only — pass --approve=<ids> to write.\n');

  const recovered = [];
  const outcomes = new Map();
  for (const venue of batch) {
    const context = { name: venue.name, address: venue.address, lat: venue.lat, lng: venue.lng, website: venue.website, sourceUrl: venue.sourceUrl };
    let result = null;
    try {
      result = await extractWebsiteHappyHourDeep(venue.website, context, { useAi: false });
    } catch (error) {
      outcomes.set('error', (outcomes.get('error') || 0) + 1);
      console.log(`  ! ${venue.name} (${venue.id}): ${error.message}`);
      continue;
    }

    const outcome = result?.outcome || 'none';
    outcomes.set(outcome, (outcomes.get(outcome) || 0) + 1);
    if (!result?.found) continue;

    // A brand-wide specials page reads the same for every branch, so a page
    // that names a different city is the likely failure here, not a blank one.
    if (conflictsWithVenue(result.sourcePage, context)) {
      outcomes.set('other_location(page)', (outcomes.get('other_location(page)') || 0) + 1);
      continue;
    }

    const offers = acceptableOffers(result.deals, venue);
    if (!offers.length) continue;

    const deals = finalizeDeals(offers);
    recovered.push({ venue, deals, sourcePage: result.sourcePage, context: result.raw });
    console.log(`  ${approved?.has(venue.id) ? '+' : '?'} ${venue.name} (${venue.id}) ${deals.join(' · ')}`);
    console.log(`      ${result.sourcePage}`);
  }

  console.log('\nExtractor outcomes:');
  for (const [outcome, count] of [...outcomes].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${outcome}`);
  }
  console.log(`\nProposed offers for ${recovered.length} of ${batch.length} listings.`);

  // The full proposal, with the happy-hour section each line was read out of,
  // so a reviewer can check a chip against its page without re-crawling. A run
  // that found nothing leaves the last real proposal in place: a reviewed
  // proposal is worth forty minutes of fetching and an empty one is worth none.
  if (!recovered.length) return;
  writeJson(PROPOSALS_PATH, recovered.map((row) => ({
    id: row.venue.id,
    name: row.venue.name,
    deals: row.deals,
    sourcePage: row.sourcePage,
    context: row.context,
  })));
  console.log(`Wrote the full proposal to ${PROPOSALS_PATH}`);

  if (!approved?.size || !recovered.length) return;
  applyApproved(recovered.map((row) => ({ ...row, id: row.venue.id })), approved);
}

// Only crawl when run as a script: the acceptance filter is the part worth
// unit-testing, and importing it must not start fetching venue websites.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
