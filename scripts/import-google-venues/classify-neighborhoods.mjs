#!/usr/bin/env node
// Re-assign neighborhoods for all venues in happy-hours.json.
//
// Usage: npm run import:venues:classify-neighborhoods

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { assignNeighborhood } from './lib/neighborhood-assign.mjs';
import { readJson, writeJson } from './lib/io.mjs';

const venues = readJson(HAPPY_HOURS_PATH, []);
const changes = new Map();

for (const venue of venues) {
  const before = venue.neighborhood;
  const next = assignNeighborhood(venue.lat, venue.lng, venue.address || '');
  if (before !== next) {
    changes.set(before, (changes.get(before) || 0) + 1);
    venue.neighborhood = next;
  }
}

writeJson(HAPPY_HOURS_PATH, venues);

const counts = new Map();
for (const venue of venues) {
  counts.set(venue.neighborhood, (counts.get(venue.neighborhood) || 0) + 1);
}

console.log(`Reclassified ${[...changes.values()].reduce((a, b) => a + b, 0)} venues.`);
console.log('\nNeighborhood counts:');
for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}\t${name}`);
}
