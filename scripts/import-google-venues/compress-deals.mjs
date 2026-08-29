#!/usr/bin/env node
// Rewrite long/marketing deal strings into short directory chips via Haiku.
// Does not recrawl websites. Default is a dry run.
//
//   npm run import:venues:compress-deals
//   npm run import:venues:compress-deals -- --apply
//   npm run import:venues:compress-deals -- --venue=khans-cave-grill-tavern --apply

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { compressDealsWithAi, hasAiExtraction } from './lib/ai-extract.mjs';
import { venueDealsNeedRewrite } from './lib/deals.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function parseCompressArgs(argv) {
  const options = { ...parseArgs(argv), apply: false, venues: [], batchSize: 12 };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--venue=')) options.venues.push(arg.slice(8));
    else if (arg.startsWith('--batch=')) options.batchSize = Number(arg.slice(8)) || 12;
  }
  return options;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  const options = parseCompressArgs(process.argv.slice(2));
  if (!hasAiExtraction()) {
    console.error('ANTHROPIC_API_KEY is required.');
    process.exit(1);
  }

  const venues = readJson(HAPPY_HOURS_PATH, []);
  let todo = venues.filter((venue) => Array.isArray(venue.deals) && venue.deals.length && venueDealsNeedRewrite(venue.deals) && !(venue.weeklySpecials || []).length);
  if (options.venues.length) {
    const wanted = new Set(options.venues);
    todo = todo.filter((venue) => wanted.has(slugify(venue.name)) || wanted.has(String(venue.id)));
  }
  if (options.limit) todo = todo.slice(0, options.limit);

  console.log(`${todo.length} venue(s) have deal copy that needs rewriting.${options.apply ? '' : ' Dry run — pass --apply to write.'}`);
  if (!todo.length) return;

  const byId = new Map(venues.map((venue) => [venue.id, venue]));
  let updated = 0;
  for (const batch of chunk(todo, options.batchSize)) {
    const rewritten = await compressDealsWithAi(batch.map((venue) => ({
      id: venue.id,
      name: venue.name,
      deals: venue.deals,
    })));
    for (const row of rewritten) {
      const venue = byId.get(row.id);
      if (!venue) continue;
      const before = venue.deals;
      venue.deals = row.deals;
      venue.dealsUnknown = false;
      updated += 1;
      console.log(`${venue.name}:`);
      for (const line of before) console.log(`  - ${line}`);
      console.log('  →');
      for (const line of row.deals) console.log(`  + ${line}`);
    }
  }

  if (options.apply) {
    writeJson(HAPPY_HOURS_PATH, venues);
    console.log(`Wrote ${updated} venue(s) to ${HAPPY_HOURS_PATH}`);
  } else {
    console.log(`${updated} venue(s) would be updated.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
