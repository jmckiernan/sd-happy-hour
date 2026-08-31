/**
 * EXPLORATORY — not part of the import pipeline. See docs/features-field-experiment.md.
 *
 * Pass 2: closed vocabulary. The vocabulary below is the owner's candidate
 * list intersected with what pass 1 actually found venues saying about
 * themselves, plus the two categories pass 1 turned up that the candidate list
 * did not have (private events, family friendly).
 *
 * Every feature must carry a verbatim quote and the URL it came from. The
 * quote is not decoration — check-quotes.mjs greps it back out of the stored
 * page text, which is how a fabricated feature gets caught.
 */
import fs from 'node:fs';
import path from 'node:path';

import { mapPool } from '../../import-google-venues/lib/fetch-page.mjs';
import { formatAiUsage } from '../../import-google-venues/lib/ai-usage.mjs';
import { askAnthropic, buildSourceBlock } from './ai.mjs';

const DIR = path.resolve(import.meta.dirname, '..', '..', '..', '.data', 'experiments', 'features-field');

export const VOCABULARY = [
  'patio',
  'rooftop',
  'waterfront view',
  'dog friendly',
  'live music',
  'sports tvs',
  'games',
  'trivia or karaoke',
  'dance floor',
  'fire pit',
  'late night',
  'brunch',
  'family friendly',
  'private events',
  'parking',
];

const SYSTEM = `You decide which of a fixed list of features a restaurant or bar's own website says it has.

FEATURES (use these exact strings, nothing else):
${VOCABULARY.map((f) => `- ${f}`).join('\n')}

What each means:
- patio: outdoor seating of any kind (patio, terrace, beer garden, sidewalk tables)
- rooftop: seating or a bar on a roof or upper deck
- waterfront view: on or overlooking the ocean, bay, harbour, or a lake
- dog friendly: dogs explicitly welcome
- sports tvs: televised sport is part of the offer (sports bar, "watch the game", many TVs)
- games: pool, darts, shuffleboard, arcade, cornhole, board games
- trivia or karaoke: a recurring trivia, bingo, or karaoke night
- dance floor: dancing, a DJ night, or a club floor
- fire pit: fire pits or outdoor fireplaces
- late night: open past midnight, or a stated late-night menu or hours
- brunch: a weekend or daily brunch service
- family friendly: kids explicitly catered for (kids menu, family friendly, high chairs)
- private events: private dining, banquet space, buyouts, party bookings
- parking: parking the venue itself advertises (free lot, validated, valet)

Rules:
1. Only assert a feature the site actually states. Never infer from venue type — a brewery is not automatically dog friendly, a bar is not automatically a sports bar.
2. Every feature needs a verbatim quote copied from a source, and that source's URL. If you cannot quote it, do not return it.
3. A quote must be about THIS location, not another branch and not a generic brand page.
4. Return an empty list when the site supports nothing. An empty list is the correct answer for a menu-only site.
5. Do not return a feature twice.

Return ONLY JSON:
{ "features": [ { "feature": string, "quote": string, "url": string, "confidence": "high" | "medium" | "low" } ] }`;

async function main() {
  const files = fs.readdirSync(path.join(DIR, 'pages')).filter((f) => f.endsWith('.json'));
  const out = [];

  await mapPool(files, 4, async (file) => {
    const record = JSON.parse(fs.readFileSync(path.join(DIR, 'pages', file), 'utf8'));
    if (!record.pages.length) {
      out.push({ id: record.venue.id, name: record.venue.name, features: [] });
      return;
    }
    try {
      const result = await askAnthropic(SYSTEM, buildSourceBlock(record), { purpose: 'features-closed' });
      const seen = new Set();
      const features = (result.features || [])
        .map((row) => ({
          feature: String(row.feature || '').toLowerCase().trim(),
          quote: String(row.quote || '').replace(/\s+/g, ' ').trim(),
          url: String(row.url || '').trim(),
          confidence: ['high', 'medium', 'low'].includes(row.confidence) ? row.confidence : 'medium',
        }))
        .filter((row) => VOCABULARY.includes(row.feature) && row.quote.length >= 4)
        .filter((row) => (seen.has(row.feature) ? false : seen.add(row.feature)));
      out.push({ id: record.venue.id, name: record.venue.name, website: record.venue.website, features });
      console.log(`  ${String(record.venue.id).padStart(5)} ${record.venue.name.slice(0, 32).padEnd(32)} ${features.map((f) => f.feature).join(', ') || '—'}`);
    } catch (error) {
      out.push({ id: record.venue.id, name: record.venue.name, features: [], error: error.message });
      console.warn(`  ! ${record.venue.name}: ${error.message}`);
    }
  });

  out.sort((a, b) => a.id - b.id);
  fs.writeFileSync(path.join(DIR, 'closed-vocabulary.json'), `${JSON.stringify(out, null, 2)}\n`);

  const counts = new Map();
  for (const row of out) for (const f of row.features) counts.set(f.feature, (counts.get(f.feature) || 0) + 1);
  console.log('\nFeature distribution:');
  for (const feature of VOCABULARY) console.log(`  ${String(counts.get(feature) || 0).padStart(3)}  ${feature}`);
  console.log(`\n${out.filter((r) => r.features.length).length}/${out.length} venues yielded at least one feature.`);
  console.log(formatAiUsage({ venues: out.length }));
}

// report.mjs imports VOCABULARY from here, so only run when invoked directly.
if (process.argv[1] === new URL(import.meta.url).pathname) main();
