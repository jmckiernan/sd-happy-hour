#!/usr/bin/env node
// Re-scrape venue websites for better happy hour deal lines.
//
// Usage:
//   npm run import:venues:refresh-deals
//   npm run import:venues:refresh-deals -- --limit=25

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { MAX_DEAL_CHIPS, finalizeDeals, isRealDealLine, needsDealRefresh } from './lib/deals.mjs';
import { extractWebsiteHappyHour } from './lib/happy-hour.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const todo = venues.filter((venue) => needsDealRefresh(venue.deals) && venue.website);
  const batch = options.limit ? todo.slice(0, options.limit) : todo;

  console.log(`Refreshing deals for ${batch.length} venues...`);

  let improved = 0;
  for (const venue of batch) {
    try {
      const result = await extractWebsiteHappyHour(venue.website);
      if (!result?.deals?.length) continue;
      const nextDeals = finalizeDeals(result.deals);
      const realDeals = nextDeals.filter(isRealDealLine);
      const currentReal = (venue.deals || []).filter(isRealDealLine);
      if (realDeals.length >= 2 && realDeals.length > currentReal.length) {
        // The cap the page renders, not a second opinion about it. This read 8
        // against a six-chip layout, so a good refresh quietly overflowed.
        venue.deals = realDeals.slice(0, MAX_DEAL_CHIPS);
        improved += 1;
        console.log(`  ✓ ${venue.name}: ${venue.deals.join(' · ')}`);
      }
    } catch (error) {
      console.warn(`  ! ${venue.name}: ${error.message}`);
    }
  }

  writeJson(HAPPY_HOURS_PATH, venues);
  console.log(`Done. Improved deals on ${improved} venues.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
