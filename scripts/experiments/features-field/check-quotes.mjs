/**
 * EXPLORATORY — not part of the import pipeline. See docs/features-field-experiment.md.
 *
 * Grounding check. Every extracted feature carries a quote and a URL; this
 * looks both back up in the frozen page text. A quote that is not on the page
 * it names is a fabrication, and a quote on a different page than claimed is a
 * provenance error. Neither tells you whether the feature is TRUE — that needs
 * a human reading the site — but a quote that does not exist is automatically
 * false, so this is the cheap half of the accuracy measurement.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, '..', '..', '..', '.data', 'experiments', 'features-field');

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
}

/** Longest run of quote words that appears in the page, as a fraction. */
function overlap(quote, haystack) {
  const words = normalize(quote).split(' ').filter(Boolean);
  if (!words.length) return 0;
  // A nav label ("Private Events") is a legitimate one- or two-word quote, so
  // short quotes are matched whole rather than by the 3-word window.
  if (words.length < 3) return haystack.includes(words.join(' ')) ? 1 : 0;
  for (let size = words.length; size >= 3; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      if (haystack.includes(words.slice(start, start + size).join(' '))) return size / words.length;
    }
  }
  return 0;
}

function main() {
  const rows = JSON.parse(fs.readFileSync(path.join(DIR, 'closed-vocabulary.json'), 'utf8'));
  const audited = [];

  for (const row of rows) {
    const record = JSON.parse(fs.readFileSync(path.join(DIR, 'pages', `${row.id}.json`), 'utf8'));
    const byUrl = new Map();
    for (const page of record.pages) byUrl.set(page.url, normalize(page.text));
    for (const account of record.social || []) byUrl.set(account.url, normalize(account.text));
    const everything = [...byUrl.values()].join('\n');

    for (const feature of row.features) {
      const claimed = byUrl.get(feature.url) ?? [...byUrl.entries()].find(([url]) => url.replace(/\/$/, '') === feature.url.replace(/\/$/, ''))?.[1];
      const onClaimedPage = claimed ? overlap(feature.quote, claimed) : 0;
      const anywhere = overlap(feature.quote, everything);
      audited.push({
        id: row.id,
        name: row.name,
        feature: feature.feature,
        quote: feature.quote,
        url: feature.url,
        confidence: feature.confidence,
        grounding: anywhere >= 0.8 ? 'verbatim' : anywhere >= 0.5 ? 'partial' : 'not found',
        urlCorrect: onClaimedPage >= 0.5,
      });
    }
  }

  fs.writeFileSync(path.join(DIR, 'quote-audit.json'), `${JSON.stringify(audited, null, 2)}\n`);

  const tally = {};
  for (const row of audited) tally[row.grounding] = (tally[row.grounding] || 0) + 1;
  console.log(`${audited.length} extracted features`);
  console.log('grounding:', tally);
  console.log(`quote on the page it names: ${audited.filter((r) => r.urlCorrect).length}/${audited.length}`);
  console.log('\nUngrounded or mis-sourced:');
  for (const row of audited.filter((r) => r.grounding !== 'verbatim' || !r.urlCorrect)) {
    console.log(`  ${row.name} — ${row.feature} [${row.grounding}${row.urlCorrect ? '' : ', wrong url'}]\n      "${row.quote}"\n      ${row.url}`);
  }
}

main();
