/**
 * EXPLORATORY — not part of the import pipeline. See docs/proprietary-venue-attributes.md §5.
 *
 * Anthropic client for the character spike. Builds an evidence packet from catalog
 * fields (menu, deals, gallery captions) plus frozen website text, preferring
 * about / vibe / bar / patio windows over happy-hour-only clips.
 */
import { parseModelJson } from '../../import-google-venues/lib/ai-extract.mjs';
import { recordAiUsage } from '../../import-google-venues/lib/ai-usage.mjs';

const MODEL = process.env.VENUE_AI_MODEL?.trim() || 'claude-haiku-4-5';
const MAX_PAGE_CHARS = 10_000;
const MAX_TOTAL_CHARS = 50_000;

const WINDOW_RE = /about|vibe|atmosphere|ambiance|ambience|our story|who we are|the bar|rooftop|patio|waterfront|harbor|marina|tiki|speakeasy|arcade|taproom|brewery|wine bar|cocktail|lounge|dive|sports bar|gastropub|neighborhood|pub\b/i;

/** Prefer a window around character language; fall back to the head of the page. */
function clipPageText(text, budget) {
  const raw = String(text || '');
  if (raw.length <= budget) return raw;
  const match = WINDOW_RE.exec(raw);
  if (!match) return raw.slice(0, budget);
  const start = Math.max(0, match.index - Math.floor(budget * 0.25));
  return raw.slice(start, start + budget);
}

export function buildEvidencePacket(record, evidence = {}) {
  const venue = record.venue;
  const parts = [
    'TARGET VENUE:',
    `- Name: ${venue.name}`,
    `- Address: ${venue.address || ''}, ${venue.neighborhood || ''}, San Diego County`,
    `- Website: ${venue.website}`,
    '',
    'NOTE: Name and neighbourhood are context only. They are never sufficient alone for a label.',
    '',
  ];

  const deals = evidence.deals || venue.deals || [];
  if (deals.length) {
    parts.push('--- SOURCE (catalog deals) ---', 'SOURCE_ID: catalog:deals', deals.map((d) => `- ${d}`).join('\n'), '');
  }

  const menu = evidence.hhMenu || null;
  if (menu) {
    const lines = [];
    if (menu.note) lines.push(`Note: ${menu.note}`);
    for (const section of menu.sections || []) {
      lines.push(`Section: ${section.title || '(untitled)'}`);
      for (const item of section.items || []) {
        const price = item.price ? ` — ${item.price}` : '';
        lines.push(`  - ${item.name || '?'}${price}`);
      }
    }
    if (lines.length) {
      parts.push('--- SOURCE (catalog hhMenu) ---', 'SOURCE_ID: catalog:hhMenu', lines.join('\n').slice(0, 8_000), '');
    }
  }

  if (evidence.weeklySpecials) {
    parts.push(
      '--- SOURCE (catalog weeklySpecials) ---',
      'SOURCE_ID: catalog:weeklySpecials',
      JSON.stringify(evidence.weeklySpecials).slice(0, 2_000),
      ''
    );
  }

  const gallery = evidence.galleryImages || [];
  const captions = gallery
    .map((img) => [img.caption, img.filename].filter(Boolean).join(' / '))
    .filter(Boolean);
  if (captions.length) {
    parts.push(
      '--- SOURCE (gallery captions / filenames) ---',
      'SOURCE_ID: catalog:gallery',
      captions.slice(0, 20).map((c) => `- ${c}`).join('\n'),
      ''
    );
  }

  let remaining = MAX_TOTAL_CHARS;
  for (const [index, page] of (record.pages || []).entries()) {
    const budget = Math.min(MAX_PAGE_CHARS, Math.max(1_500, Math.floor(remaining / Math.max(1, record.pages.length - index))));
    const body = clipPageText(page.text, budget);
    remaining -= body.length;
    parts.push(`--- SOURCE ${index + 1} ---`, `SOURCE_ID: ${page.url}`, `URL: ${page.url}`, body, '');
    if (remaining < 800) break;
  }

  for (const account of record.social || []) {
    parts.push(
      `--- SOURCE (${account.network}) ---`,
      `SOURCE_ID: ${account.url}`,
      `URL: ${account.url}`,
      String(account.text || '').slice(0, 1_500),
      ''
    );
  }

  return parts.join('\n');
}

export async function askAnthropic(system, userText, { purpose, maxTokens = 1024 } = {}) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY?.trim(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  recordAiUsage(purpose, data.usage, { model: MODEL });
  const block = data.content?.find((item) => item.type === 'text');
  if (!block?.text) throw new Error('Anthropic returned no text');
  return parseModelJson(block.text);
}
