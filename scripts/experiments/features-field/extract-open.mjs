/**
 * EXPLORATORY — not part of the import pipeline. See docs/features-field-experiment.md.
 *
 * Pass 1: open vocabulary. The model is given no candidate feature list at all
 * and asked what each venue advertises about itself, in the venue's own words.
 * The point is to let the vocabulary come out of the evidence — a list handed
 * to the model in advance would only tell us how often it can be talked into
 * agreeing with a guess.
 */
import fs from 'node:fs';
import path from 'node:path';

import { mapPool } from '../../import-google-venues/lib/fetch-page.mjs';
import { formatAiUsage } from '../../import-google-venues/lib/ai-usage.mjs';
import { askAnthropic, buildSourceBlock } from './ai.mjs';

const DIR = path.resolve(import.meta.dirname, '..', '..', '..', '.data', 'experiments', 'features-field');

const SYSTEM = `You read a restaurant or bar's own website and list the physical and experiential attributes it advertises about itself.

An attribute is something a customer might filter a directory by: what the place has, what happens there, what you can see or do. Not the food, not the prices, not the happy hour times, not the address.

Rules:
1. Use the venue's own vocabulary, lowercased, 1-3 words. Do not translate into a standard taxonomy.
2. Every attribute needs a verbatim quote from a source, and the URL it came from. No quote, no attribute.
3. Only claims the site makes about THIS location. Ignore other branches, ignore generic marketing adjectives ("great vibes", "welcoming"), ignore anything you inferred rather than read.
4. A photo caption or alt text is not evidence. Navigation labels are: a "Patio" nav link is a real claim.
5. Return at most 12 attributes. Return an empty list if the site says nothing concrete.

Return ONLY JSON:
{ "attributes": [ { "attribute": string, "quote": string, "url": string } ], "siteQuality": "rich" | "thin" | "unusable", "notes": string }

siteQuality: "rich" when the site has real prose about the venue, "thin" when it is a one-page splash or a menu with no description, "unusable" when the pages carry no venue content at all.`;

async function main() {
  const files = fs.readdirSync(path.join(DIR, 'pages')).filter((f) => f.endsWith('.json'));
  const out = [];

  await mapPool(files, 4, async (file) => {
    const record = JSON.parse(fs.readFileSync(path.join(DIR, 'pages', file), 'utf8'));
    if (!record.pages.length) {
      out.push({ id: record.venue.id, name: record.venue.name, attributes: [], siteQuality: 'unusable' });
      return;
    }
    try {
      const result = await askAnthropic(SYSTEM, buildSourceBlock(record), { purpose: 'features-open' });
      out.push({
        id: record.venue.id,
        name: record.venue.name,
        siteQuality: result.siteQuality || 'thin',
        notes: result.notes || '',
        attributes: (result.attributes || []).map((row) => ({
          attribute: String(row.attribute || '').toLowerCase().trim(),
          quote: String(row.quote || '').replace(/\s+/g, ' ').trim(),
          url: String(row.url || '').trim(),
        })).filter((row) => row.attribute && row.quote),
      });
      console.log(`  ${String(record.venue.id).padStart(5)} ${record.venue.name.slice(0, 32).padEnd(32)} ${out[out.length - 1].attributes.length} attribute(s)`);
    } catch (error) {
      out.push({ id: record.venue.id, name: record.venue.name, attributes: [], error: error.message });
      console.warn(`  ! ${record.venue.name}: ${error.message}`);
    }
  });

  out.sort((a, b) => a.id - b.id);
  fs.writeFileSync(path.join(DIR, 'open-vocabulary.json'), `${JSON.stringify(out, null, 2)}\n`);

  const counts = new Map();
  for (const row of out) for (const attr of row.attributes) counts.set(attr.attribute, (counts.get(attr.attribute) || 0) + 1);
  console.log('\nRaw attribute phrases, most common first:');
  for (const [attr, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) {
    console.log(`  ${String(n).padStart(3)}  ${attr}`);
  }
  console.log(`\n${counts.size} distinct phrases across ${out.length} venues.`);
  console.log(formatAiUsage({ venues: out.length }));
}

main();
