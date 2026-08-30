#!/usr/bin/env node
// Re-apply the offer filter to deal text already in the catalog.
//
// `stripNonOffers` runs at import, so listings merged before a given fix keep
// whatever the extractor handed over at the time — 99 venues went live with
// "Happy hour" as their only "deal", which is the heading the extractor was
// reading rather than anything you can order.
//
// A venue left with no offers is not a venue with no happy hour: we still know
// its window. That is what `dealsUnknown` means, and the card renders a
// "specials not published" line instead of inventing one.
//
// Usage:
//   npm run clean:deals -- --dry-run
//   npm run clean:deals

import { execSync } from 'node:child_process';
import { HAPPY_HOURS_PATH, ROOT_DIR } from './lib/constants.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { stripNonOffers } from './lib/normalize.mjs';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = readJson(HAPPY_HOURS_PATH, []);

  let trimmed = 0;
  let emptied = 0;
  const samples = [];

  const cleaned = catalog.map((venue) => {
    const deals = venue.deals || [];
    if (!deals.length) return venue;

    const kept = stripNonOffers(deals, venue.name);
    if (kept.length === deals.length) return venue;

    trimmed += 1;
    if (samples.length < 15) {
      samples.push(`  ${venue.name}\n      was: ${JSON.stringify(deals)}\n      now: ${JSON.stringify(kept)}`);
    }
    if (!kept.length) {
      emptied += 1;
      return { ...venue, deals: [], dealsUnknown: true };
    }
    return { ...venue, deals: kept };
  });

  console.log(`Listings: ${catalog.length}`);
  console.log(`  deal text trimmed: ${trimmed}`);
  console.log(`  left with no offers (now dealsUnknown): ${emptied}`);
  console.log('\nSamples:');
  console.log(samples.join('\n'));

  if (options.dryRun) {
    console.log('\nDry run — nothing written.');
    return;
  }

  writeJson(HAPPY_HOURS_PATH, cleaned);
  console.log(`\nWrote ${cleaned.length} listings.`);

  try {
    execSync('npm run validate:data', { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch {
    console.error('Validation failed. Review happy-hours.json.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
