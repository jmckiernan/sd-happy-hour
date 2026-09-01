/**
 * EXPLORATORY — not part of the import pipeline. See docs/proprietary-venue-attributes.md §5.
 *
 * Closed-vocabulary character extract. One call per venue. Returns at most one
 * value from the twelve, or none, with a verbatim quote and source id.
 */
import fs from 'node:fs';
import path from 'node:path';

import { mapPool } from '../../import-google-venues/lib/fetch-page.mjs';
import { formatAiUsage, aiUsageTotals } from '../../import-google-venues/lib/ai-usage.mjs';
import { askAnthropic, buildEvidencePacket } from './ai.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DIR = path.join(ROOT, '.data', 'experiments', 'venue-character');

export const VOCABULARY = [
  'dive',
  'sports bar',
  'neighborhood pub',
  'brewery taproom',
  'wine bar',
  'cocktail lounge',
  'rooftop',
  'waterfront',
  'gastropub',
  'tiki',
  'speakeasy',
  'arcade bar',
];

const SYSTEM = `You assess the *character of the room* at a San Diego happy-hour venue from its own evidence packet.

Choose AT MOST ONE value from this closed list, or none:

${VOCABULARY.map((v) => `- ${v}`).join('\n')}

What each means (visitor decision, not marketing):
- dive: cheap, no-frills, locals — not a sports-TV pitch
- sports bar: watching the game is the reason to go
- neighborhood pub: casual local hang; the room is the point, not brewing
- brewery taproom: beer-first, often patio; brewing on-site or branded as such
- wine bar: wine-forward, usually quieter and smaller
- cocktail lounge: crafted cocktails, dressier room, sit-down pace
- rooftop: view and elevation are the product (patio alone does NOT qualify)
- waterfront: bay / ocean / marina setting is why you go
- gastropub: food-forward bar; the menu is why you stay
- tiki: thematic tropical cocktails — a deliberate mood
- speakeasy: hidden / intimate / reservation-leaning cocktail room
- arcade bar: games are the premise, drinks follow

Rules:
1. Return "none" when evidence is thin, conflicting, or only establishment-kind / cuisine. Absence is correct. Never guess.
2. Do NOT infer from kind alone ("it is a brewery → brewery taproom") unless name or copy actually supports that character — and even then prefer none if the packet only restates kind.
3. Do NOT leap from marketing adjectives ("family atmosphere" ≠ dive; "upscale dining" ≠ cocktail lounge; "great vibes" ≠ anything).
4. Every non-none answer needs a verbatim quote copied from a SOURCE block and that block's SOURCE_ID (catalog:deals, catalog:hhMenu, a page URL, etc.). If you cannot quote it, return none.
5. Quotes must be about THIS location, not another branch or a generic brand page.
6. When two values compete, pick the one a visitor would use to *filter*, and say so in reason. Do not invent compounds.
7. Catalog deals and menu item names are weak character evidence by themselves — use them only when they clearly signal room character (e.g. "tiki cocktails", "arcade tokens"). Website about-copy and venue self-description are stronger.

Return ONLY JSON:
{
  "vibe": string | null,
  "quote": string | null,
  "sourceId": string | null,
  "confidence": "high" | "medium" | "low" | null,
  "reason": string
}

Use vibe: null (and quote/sourceId/confidence null) for none/absent.`;

async function main() {
  const sample = JSON.parse(fs.readFileSync(path.join(DIR, 'sample.json'), 'utf8'));
  const evidenceById = sample.evidence || {};
  const files = fs.readdirSync(path.join(DIR, 'pages')).filter((f) => f.endsWith('.json'));
  const out = [];

  await mapPool(files, 4, async (file) => {
    const record = JSON.parse(fs.readFileSync(path.join(DIR, 'pages', file), 'utf8'));
    const evidence = evidenceById[record.venue.id] || {};
    const hasAnyEvidence =
      (record.pages || []).length > 0
      || (evidence.deals || []).length > 0
      || Boolean(evidence.hhMenu)
      || (evidence.galleryImages || []).length > 0;

    if (!hasAnyEvidence) {
      out.push({
        id: record.venue.id,
        name: record.venue.name,
        vibe: null,
        quote: null,
        sourceId: null,
        confidence: null,
        reason: 'no evidence packet',
      });
      return;
    }

    try {
      const result = await askAnthropic(SYSTEM, buildEvidencePacket(record, evidence), {
        purpose: 'character-closed',
        maxTokens: 512,
      });
      let vibe = result.vibe == null || result.vibe === 'none' || result.vibe === ''
        ? null
        : String(result.vibe).toLowerCase().trim();
      if (vibe && !VOCABULARY.includes(vibe)) vibe = null;
      const quote = vibe ? String(result.quote || '').replace(/\s+/g, ' ').trim() : null;
      if (vibe && (!quote || quote.length < 4)) {
        out.push({
          id: record.venue.id,
          name: record.venue.name,
          website: record.venue.website,
          vibe: null,
          quote: null,
          sourceId: null,
          confidence: null,
          reason: `model returned ${vibe} without usable quote; coerced to none`,
          raw: result,
        });
        console.log(`  ${String(record.venue.id).padStart(5)} ${record.venue.name.slice(0, 32).padEnd(32)} — (dropped unquoted ${vibe})`);
        return;
      }
      const row = {
        id: record.venue.id,
        name: record.venue.name,
        website: record.venue.website,
        vibe,
        quote,
        sourceId: vibe ? String(result.sourceId || '').trim() || null : null,
        confidence: vibe && ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : vibe ? 'medium' : null,
        reason: String(result.reason || '').trim(),
      };
      out.push(row);
      console.log(
        `  ${String(record.venue.id).padStart(5)} ${record.venue.name.slice(0, 32).padEnd(32)} ${vibe || '—'}`
      );
    } catch (error) {
      out.push({
        id: record.venue.id,
        name: record.venue.name,
        vibe: null,
        quote: null,
        sourceId: null,
        confidence: null,
        reason: '',
        error: error.message,
      });
      console.warn(`  ! ${record.venue.name}: ${error.message}`);
    }
  });

  out.sort((a, b) => a.id - b.id);
  const usage = aiUsageTotals();
  fs.writeFileSync(
    path.join(DIR, 'closed-vocabulary.json'),
    `${JSON.stringify({ extractedAt: new Date().toISOString(), costUsd: usage.all.costUsd, venues: out }, null, 2)}\n`
  );

  const labelled = out.filter((r) => r.vibe);
  const counts = new Map();
  for (const row of labelled) counts.set(row.vibe, (counts.get(row.vibe) || 0) + 1);
  console.log('\nVibe distribution (labelled only):');
  for (const vibe of VOCABULARY) console.log(`  ${String(counts.get(vibe) || 0).padStart(3)}  ${vibe}`);
  console.log(`\n${labelled.length}/${out.length} venues labelled; ${out.length - labelled.length} absent.`);
  console.log(formatAiUsage({ venues: out.length }));
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
