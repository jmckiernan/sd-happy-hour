#!/usr/bin/env node
// Record what each stored menu price actually means.
//
// Every item already carries the price string the venue printed. This reads
// that text and attaches the `offer` that says whether it is a cost, a saving,
// a span or a bundle — see lib/menu-price.mjs for why the distinction matters.
//
// Nothing is rewritten and nothing is inferred: the printed text is untouched,
// and an item whose text does not clearly fit a kind is left with no `offer`
// and reported for a human. Roughly a hundred of those turn out not to be
// prices at all but ingredient descriptions that leaked into the field, which
// is a separate bug this surfaces rather than papers over.
//
// Usage:
//   node scripts/import-google-venues/backfill-menu-offers.mjs --dry-run
//   node scripts/import-google-venues/backfill-menu-offers.mjs

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { classifyOffer } from './lib/menu-price.mjs';

const dryRun = process.argv.includes('--dry-run');
const venues = readJson(HAPPY_HOURS_PATH, []);

const counts = new Map();
const unclassified = [];
let changed = 0;
let venuesTouched = 0;

for (const venue of venues) {
  let touched = false;
  for (const section of venue.hhMenu?.sections || []) {
    for (const item of section.items || []) {
      const raw = String(item.price || '').trim();
      if (!raw) continue;
      const offer = classifyOffer(raw);
      const kind = offer ? offer.kind : 'unclassified';
      counts.set(kind, (counts.get(kind) || 0) + 1);
      if (!offer) {
        unclassified.push({ id: venue.id, name: venue.name, item: item.name, price: raw });
        // Leave any stale offer off rather than keeping a classification the
        // current text no longer supports.
        if (item.offer) {
          delete item.offer;
          changed += 1;
          touched = true;
        }
        continue;
      }
      if (JSON.stringify(item.offer) !== JSON.stringify(offer)) {
        item.offer = offer;
        changed += 1;
        touched = true;
      }
    }
  }
  if (touched) venuesTouched += 1;
}

console.log(`Classified prices across ${venues.length} listing(s):\n`);
const total = [...counts.values()].reduce((a, b) => a + b, 0);
for (const [kind, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(14)} ${String(n).padStart(5)}  ${((100 * n) / total).toFixed(1)}%`);
}
const discounts = (counts.get('amount_off') || 0) + (counts.get('percent_off') || 0);
console.log(`\n  a saving rather than a cost: ${discounts}`);
console.log(`  items updated:               ${changed} across ${venuesTouched} listing(s)`);

console.log(`\n  left unclassified for a human (${unclassified.length}):`);
const seen = new Set();
for (const row of unclassified) {
  if (seen.has(row.price)) continue;
  seen.add(row.price);
  if (seen.size > 20) break;
  console.log(`    ${String(row.id).padStart(4)} ${row.name} — "${row.price}" (${row.item})`);
}
console.log(`    ${seen.size > 20 ? `…and more; ` : ''}${new Set(unclassified.map((r) => r.price)).size} distinct strings`);

if (dryRun) {
  console.log('\nDry run — nothing written.');
  process.exit(0);
}

// The catalog is shared with other agents and long-running jobs, so merge into
// whatever is on disk now rather than writing back the copy read at startup.
const current = readJson(HAPPY_HOURS_PATH, []);
const offersById = new Map();
for (const venue of venues) {
  for (const section of venue.hhMenu?.sections || []) {
    for (const item of section.items || []) {
      offersById.set(`${venue.id}\u0000${section.title}\u0000${item.name}`, item.offer || null);
    }
  }
}
let merged = 0;
for (const venue of current) {
  for (const section of venue.hhMenu?.sections || []) {
    for (const item of section.items || []) {
      const key = `${venue.id}\u0000${section.title}\u0000${item.name}`;
      if (!offersById.has(key)) continue;
      const offer = offersById.get(key);
      // Re-derive from the text on disk: if another job rewrote this price,
      // the classification we computed for the old text no longer applies.
      const fresh = classifyOffer(item.price);
      const next = JSON.stringify(fresh) === JSON.stringify(offer) ? offer : fresh;
      if (next) {
        if (JSON.stringify(item.offer) !== JSON.stringify(next)) merged += 1;
        item.offer = next;
      } else if (item.offer) {
        delete item.offer;
        merged += 1;
      }
    }
  }
}
writeJson(HAPPY_HOURS_PATH, current);
console.log(`\nWrote ${merged} item(s) into the catalog on disk.`);
