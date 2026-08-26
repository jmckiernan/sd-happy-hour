#!/usr/bin/env node
// Merge staged import venues into public/data/happy-hours.json.
//
// Usage:
//   npm run import:venues:merge -- --dry-run
//   npm run import:venues:merge

import { execSync } from 'node:child_process';
import { HAPPY_HOURS_PATH, STAGING_PATH, ROOT_DIR } from './lib/constants.mjs';
import { stripImportMeta } from './lib/normalize.mjs';
import { parseArgs, readJson, writeJson } from './lib/io.mjs';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const staging = readJson(STAGING_PATH);
  if (!staging?.venues?.length) {
    if (options.dryRun) {
      console.log('Dry run: no staged venues to merge (complete discovery/enrich/extract first).');
      return;
    }
    console.error('No staged venues. Run npm run import:venues:stage first.');
    process.exit(1);
  }

  const existing = readJson(HAPPY_HOURS_PATH, []);
  const merged = [...existing, ...staging.venues.map(stripImportMeta)];

  if (options.dryRun) {
    console.log(`Dry run: would append ${staging.venues.length} venues (${existing.length} → ${merged.length}).`);
    console.log('Sample new venues:');
    for (const venue of staging.venues.slice(0, 5)) {
      console.log(`  - ${venue.name} (${venue.neighborhood}) · ${venue.startTime}-${venue.endTime} · HH via ${venue._import.happyHourSource}`);
    }
    return;
  }

  writeJson(HAPPY_HOURS_PATH, merged);
  console.log(`Merged ${staging.venues.length} venues into ${HAPPY_HOURS_PATH} (${merged.length} total).`);

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
