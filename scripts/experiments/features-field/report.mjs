/**
 * EXPLORATORY — not part of the import pipeline. See docs/features-field-experiment.md.
 *
 * Joins the extraction, the quote-grounding check and the hand-written
 * verdicts into the coverage / accuracy / distribution numbers, and prints the
 * per-venue table the write-up uses. Every figure in the document comes out of
 * here rather than out of a summary the model wrote about its own work.
 */
import fs from 'node:fs';
import path from 'node:path';

import { VOCABULARY } from './extract-closed.mjs';

const DIR = path.resolve(import.meta.dirname, '..', '..', '..', '.data', 'experiments', 'features-field');
const read = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

const sample = read('sample.json').venues;
const extracted = read('closed-vocabulary.json');
const audit = read('quote-audit.json');
const { verdicts } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'verdicts.json'), 'utf8'));

const verdictOf = new Map(verdicts.map((row) => [`${row.id}|${row.feature}`, row]));
const extractedRows = extracted.flatMap((row) => row.features.map((f) => ({ id: row.id, name: row.name, ...f })));

const missing = extractedRows.filter((row) => !verdictOf.has(`${row.id}|${row.feature}`));
if (missing.length) {
  console.error('No verdict recorded for:', missing.map((r) => `${r.name}/${r.feature}`));
  process.exitCode = 1;
}

const tally = { true: 0, false: 0, uncertain: 0 };
for (const row of extractedRows) tally[verdictOf.get(`${row.id}|${row.feature}`)?.verdict || 'uncertain'] += 1;

const venuesWithAny = extracted.filter((row) => row.features.length).length;
const venuesWithTrue = extracted.filter((row) =>
  row.features.some((f) => verdictOf.get(`${row.id}|${f.feature}`)?.verdict === 'true')
).length;

console.log(`Sample: ${sample.length} venues, all with a readable website.\n`);
console.log('--- Coverage ---');
console.log(`  at least one feature extracted:     ${venuesWithAny}/${sample.length} (${((venuesWithAny / sample.length) * 100).toFixed(0)}%)`);
console.log(`  at least one feature that is TRUE:  ${venuesWithTrue}/${sample.length} (${((venuesWithTrue / sample.length) * 100).toFixed(0)}%)`);
console.log(`  features extracted per venue:       ${(extractedRows.length / sample.length).toFixed(2)}\n`);

console.log('--- Accuracy ---');
console.log(`  extracted features:                 ${extractedRows.length}`);
for (const key of ['true', 'false', 'uncertain']) {
  console.log(`  ${key.padEnd(34)}${tally[key]} (${((tally[key] / extractedRows.length) * 100).toFixed(0)}%)`);
}
const grounded = audit.filter((row) => row.grounding !== 'not found').length;
console.log(`  quote found in the fetched page:    ${grounded}/${audit.length}\n`);

console.log('--- Distribution ---');
console.log('  feature              extracted  true  share of 30');
for (const feature of VOCABULARY) {
  const rows = extractedRows.filter((row) => row.feature === feature);
  const trues = rows.filter((row) => verdictOf.get(`${row.id}|${row.feature}`)?.verdict === 'true').length;
  console.log(`  ${feature.padEnd(20)} ${String(rows.length).padStart(9)}  ${String(trues).padStart(4)}  ${((trues / sample.length) * 100).toFixed(0).padStart(9)}%`);
}

console.log('\n--- Per-venue table (markdown) ---\n');
console.log('| Venue | Type | Features found | Source page | Verdict |');
console.log('|---|---|---|---|---|');
const shortUrl = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
};
for (const venue of sample) {
  const row = extracted.find((r) => r.id === venue.id);
  const features = row?.features || [];
  if (!features.length) {
    console.log(`| ${venue.name} | ${venue.type} | — | — | nothing extracted |`);
    continue;
  }
  const cells = features.map((f) => {
    const verdict = verdictOf.get(`${venue.id}|${f.feature}`)?.verdict || '?';
    return `${f.feature} (${verdict})`;
  });
  const pages = [...new Set(features.map((f) => shortUrl(f.url)))];
  console.log(`| ${venue.name} | ${venue.type} | ${features.map((f) => f.feature).join(', ')} | ${pages.join('<br>')} | ${cells.map((c) => c.split(' ')[c.split(' ').length - 1]).join(' ')} |`);
}
