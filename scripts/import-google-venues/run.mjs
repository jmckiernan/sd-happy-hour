#!/usr/bin/env node
// Run the full import pipeline with optional step limits for smoke tests.
//
// Usage:
//   GOOGLE_PLACES_API_KEY=... npm run import:venues
//   npm run import:venues -- --discover-limit=3 --enrich-limit=10 --extract-limit=5 --dry-run

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function run(script, extraArgs = []) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...extraArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function argValue(name) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

const discoverLimit = argValue('discover-limit');
const enrichLimit = argValue('enrich-limit');
const extractLimit = argValue('extract-limit');
const dryRun = process.argv.includes('--dry-run');

console.log('Step 1/5: Discover candidates');
run('discover.mjs', [
  ...(discoverLimit ? [`--limit=${discoverLimit}`] : []),
  ...(discoverLimit || enrichLimit || extractLimit ? ['--smoke'] : []),
]);

console.log('\nStep 2/5: Enrich with Place Details');
run('enrich.mjs', enrichLimit ? [`--limit=${enrichLimit}`] : []);

console.log('\nStep 3/5: Extract happy hour (Google + website)');
run('extract-happy-hour.mjs', extractLimit ? [`--limit=${extractLimit}`] : []);

console.log('\nStep 4/5: Build staging file');
run('build-staging.mjs');

console.log('\nStep 5/5: Merge');
run('merge.mjs', dryRun ? ['--dry-run'] : []);

console.log('\nImport pipeline complete.');
