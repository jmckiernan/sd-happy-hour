/**
 * EXPLORATORY — not part of the import pipeline. See docs/proprietary-venue-attributes.md §5.
 *
 * Joins extraction, quote grounding, and hand verdicts into pass/fail numbers.
 *
 * Pass criteria (among labelled): ≥85% true, ≤10% false. Absent-correctly is
 * tracked separately and is not a failure. Uncertain does not ship.
 */
import fs from 'node:fs';
import path from 'node:path';

import { VOCABULARY } from './extract-closed.mjs';

const DIR = path.resolve(import.meta.dirname, '..', '..', '..', '.data', 'experiments', 'venue-character');
const read = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

const sample = read('sample.json');
const extractedPayload = read('closed-vocabulary.json');
const extracted = extractedPayload.venues || extractedPayload;
const audit = read('quote-audit.json');
const { verdicts } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'verdicts.json'), 'utf8'));

const verdictOf = new Map(verdicts.map((row) => [row.id, row]));

const missing = extracted.filter((row) => !verdictOf.has(row.id));
if (missing.length) {
  console.error('No verdict recorded for:', missing.map((r) => `${r.id} ${r.name}`));
  process.exitCode = 1;
}

const labelled = extracted.filter((row) => row.vibe);
const absent = extracted.filter((row) => !row.vibe);

const tally = { true: 0, false: 0, uncertain: 0, 'absent-correctly': 0, 'absent-miss': 0 };
for (const row of extracted) {
  const v = verdictOf.get(row.id)?.verdict;
  if (!v) continue;
  if (row.vibe) {
    if (v === 'true' || v === 'false' || v === 'uncertain') tally[v] += 1;
  } else if (v === 'absent-correctly') {
    tally['absent-correctly'] += 1;
  } else if (v === 'absent-miss') {
    tally['absent-miss'] += 1;
  }
}

const labelledN = labelled.length || 1;
const trueRate = tally.true / labelled.length;
const falseRate = tally.false / labelled.length;
const grounded = audit.filter((row) => row.vibe && row.grounding === 'verbatim').length;
const pass =
  labelled.length > 0
  && trueRate >= 0.85
  && falseRate <= 0.1
  && tally.uncertain === 0
  && grounded === labelled.length;

console.log(`Sample: ${sample.venues.length} published venues.\n`);
console.log('--- Coverage ---');
console.log(`  labelled:              ${labelled.length}/${sample.venues.length}`);
console.log(`  absent:                ${absent.length}/${sample.venues.length}`);
console.log(`  absent-correctly:      ${tally['absent-correctly']}`);
console.log(`  absent-miss (should have labelled): ${tally['absent-miss']}\n`);

console.log('--- Accuracy (labelled only) ---');
console.log(`  labelled:              ${labelled.length}`);
console.log(`  true:                  ${tally.true} (${((tally.true / labelledN) * 100).toFixed(1)}%)`);
console.log(`  false:                 ${tally.false} (${((tally.false / labelledN) * 100).toFixed(1)}%)`);
console.log(`  uncertain:             ${tally.uncertain}`);
console.log(`  quote verbatim:        ${grounded}/${labelled.length}`);
console.log(`  model cost USD:        $${Number(extractedPayload.costUsd || 0).toFixed(4)}\n`);

console.log('--- Pass criteria ---');
console.log(`  ≥85% true among labelled:  ${((trueRate || 0) * 100).toFixed(1)}%  ${trueRate >= 0.85 ? 'OK' : 'FAIL'}`);
console.log(`  ≤10% false labels:         ${((falseRate || 0) * 100).toFixed(1)}%  ${falseRate <= 0.1 ? 'OK' : 'FAIL'}`);
console.log(`  uncertain must not ship:   ${tally.uncertain === 0 ? 'OK' : 'FAIL'}`);
console.log(`  100% quotes grounded:      ${grounded === labelled.length ? 'OK' : 'FAIL'}`);
console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'}\n`);

console.log('--- Distribution ---');
for (const vibe of VOCABULARY) {
  const rows = labelled.filter((row) => row.vibe === vibe);
  const trues = rows.filter((row) => verdictOf.get(row.id)?.verdict === 'true').length;
  console.log(`  ${vibe.padEnd(20)} ${String(rows.length).padStart(3)} labelled  ${String(trues).padStart(3)} true`);
}

console.log('\n--- Per-venue ---\n');
console.log('| Venue | Evidence | Model vibe | Quote | Hand verdict |');
console.log('|---|---|---|---|---|');
for (const venue of sample.venues) {
  const row = extracted.find((r) => r.id === venue.id);
  const hand = verdictOf.get(venue.id);
  const quote = row?.quote ? String(row.quote).slice(0, 80).replace(/\|/g, '/') : '—';
  console.log(
    `| ${venue.name} | ${venue.evidenceClass} | ${row?.vibe || '—'} | ${quote} | ${hand?.verdict || '?'} |`
  );
}
