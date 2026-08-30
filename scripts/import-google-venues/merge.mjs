#!/usr/bin/env node
// Merge staged import venues into public/data/happy-hours.json.
//
// Usage:
//   npm run import:venues:merge -- --dry-run
//   npm run import:venues:merge

import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HAPPY_HOURS_PATH, STAGING_PATH, ROOT_DIR } from './lib/constants.mjs';
import { stripImportMeta } from './lib/normalize.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

/**
 * Refuse to merge deal text an older version of the code produced.
 *
 * The filters run at staging time and their output is frozen into
 * staging.json; merge only copies rows across. So fixing a filter does nothing
 * for a staging file built before the fix, and merging one publishes the old
 * answer no matter how current the code is. That is how 99 venues went live
 * with "Happy hour" as their only deal after the filter that rejects it had
 * already been written.
 */
function stagingIsStale(builtAt) {
  if (!builtAt) return 'staging.json has no builtAt timestamp';
  const built = new Date(builtAt).getTime();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const shapers = [
    'lib/normalize.mjs',
    'lib/deals.mjs',
    'lib/dedupe.mjs',
    'lib/chain-blocklist.mjs',
    'lib/county.mjs',
    'build-staging.mjs',
  ];
  for (const file of shapers) {
    const changed = statSync(path.join(here, file)).mtimeMs;
    if (changed > built) return `${file} changed after staging was built`;
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const staging = readJson(STAGING_PATH);
  const upgrades = staging?.upgrades || [];
  if (!staging?.venues?.length && !upgrades.length) {
    if (options.dryRun) {
      console.log('Dry run: no staged venues to merge (complete discovery/enrich/extract first).');
      return;
    }
    console.error('No staged venues. Run npm run import:venues:stage first.');
    process.exit(1);
  }

  const stale = stagingIsStale(staging?.meta?.builtAt);
  if (stale && !options.force) {
    console.error(`Refusing to merge: ${stale}.`);
    console.error('Re-run `npm run import:venues:stage`, or pass --force to merge it anyway.');
    process.exit(1);
  }

  const existing = readJson(HAPPY_HOURS_PATH, []);

  // Turn claimable stubs into real listings in place, so the venue keeps its id
  // and URL and any claim already pointing at it survives.
  const byId = new Map(upgrades.map((upgrade) => [upgrade.id, upgrade]));
  let upgraded = 0;
  const withUpgrades = existing.map((venue) => {
    const upgrade = byId.get(venue.id);
    if (!upgrade) return venue;
    upgraded += 1;
    const { id, name, confidence, source, ...fields } = upgrade;
    return { ...venue, ...fields };
  });

  const merged = [...withUpgrades, ...staging.venues.map(stripImportMeta)];

  if (options.dryRun) {
    console.log(`Dry run: would append ${staging.venues.length} venues and upgrade ${upgraded} stubs (${existing.length} → ${merged.length}).`);
    console.log('Sample new venues:');
    for (const venue of staging.venues.slice(0, 5)) {
      console.log(`  - ${venue.name} (${venue.neighborhood}) · ${venue.startTime}-${venue.endTime} · HH via ${venue._import.happyHourSource}`);
    }
    console.log('Sample stub upgrades:');
    for (const upgrade of upgrades.slice(0, 5)) {
      console.log(`  - ${upgrade.name} · ${upgrade.startTime}-${upgrade.endTime} · HH via ${upgrade.source}`);
    }
    return;
  }

  writeJson(HAPPY_HOURS_PATH, merged);
  console.log(`Merged ${staging.venues.length} new venues and upgraded ${upgraded} stubs into ${HAPPY_HOURS_PATH} (${merged.length} total).`);

  try {
    execSync('npm run validate:data', { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch {
    console.error('Validation failed after merge. Review happy-hours.json and fix errors.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
