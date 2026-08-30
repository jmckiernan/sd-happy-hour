#!/usr/bin/env node
// Promote claimable stubs that now have a happy hour.
//
// Staging dedupes new venues against the catalog, and a stub *is* a catalog
// entry, so a venue that gained a happy hour after its stub was created gets
// skipped as a duplicate and the finding is silently dropped. This closes that
// gap by upgrading the stub in place, keeping its id so any claim already
// attached to it survives.
//
// Runs the full normalizeVenue guards rather than trusting the extractor: the
// first pass over these turned up Cheesecake Factory at 11:00-22:00 and a
// casino at 13:00-08:00, which are opening hours, not happy hours.
//
// Usage:
//   npm run upgrade:stubs -- --dry-run
//   npm run upgrade:stubs

import { execSync } from 'node:child_process';
import { HAPPY_HOURS_PATH, WITH_HH_PATH, ROOT_DIR } from './lib/constants.mjs';
import { normalizeVenue, stripImportMeta } from './lib/normalize.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';
import { isCorporateFastFood } from './lib/chain-blocklist.mjs';

function idOf(record) {
  return String(record.googlePlaceId || record.id || '').replace(/^places\//, '');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = readJson(HAPPY_HOURS_PATH, []);
  const found = readJson(WITH_HH_PATH)?.places || {};

  const stubsById = new Map(
    catalog
      .filter((venue) => venue.hasHappyHourData === false && !venue.startTime && venue.placeId)
      .map((venue) => [venue.placeId, venue])
  );

  const upgrades = [];
  const rejected = [];

  for (const record of Object.values(found)) {
    if (!record.hasHappyHour || !record.happyHour) continue;
    const stub = stubsById.get(idOf(record));
    if (!stub) continue;
    if (isCorporateFastFood(stub.name)) continue;

    // Keeping the stub's id preserves any claim already pointing at it.
    const upgraded = normalizeVenue(record, stub.id);
    if (!upgraded) {
      rejected.push({
        name: stub.name,
        window: `${record.happyHour.startTime}-${record.happyHour.endTime}`,
      });
      continue;
    }
    upgrades.push({ stub, upgraded });
  }

  console.log(`Stubs in catalog: ${stubsById.size}`);
  console.log(`Stubs that now have a happy hour: ${upgrades.length + rejected.length}`);
  console.log(`  upgrading: ${upgrades.length}`);
  console.log(`  rejected by the plausibility guards: ${rejected.length}`);
  for (const row of rejected) console.log(`    ${row.name} — ${row.window}`);

  if (!upgrades.length || options.dryRun) {
    if (upgrades.length) {
      console.log('\nWould upgrade:');
      for (const { upgraded } of upgrades) {
        console.log(`  ${upgraded.name} — ${upgraded.startTime}-${upgraded.endTime} :: ${upgraded.deals.join(', ')}`);
      }
    }
    return;
  }

  const byId = new Map(upgrades.map(({ stub, upgraded }) => [stub.id, stripImportMeta(upgraded)]));
  const next = catalog.map((venue) => byId.get(venue.id) || venue);

  writeJson(HAPPY_HOURS_PATH, next);
  console.log(`\nUpgraded ${upgrades.length} stubs into published listings.`);
  for (const { upgraded } of upgrades) {
    console.log(`  ${upgraded.name} — ${upgraded.startTime}-${upgraded.endTime}`);
  }

  try {
    execSync('npm run validate:data', { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch {
    console.error('Validation failed after upgrade. Review happy-hours.json.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
