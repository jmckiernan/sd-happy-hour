/**
 * EXPLORATORY — not part of the import pipeline. See docs/features-field-experiment.md.
 *
 * A thin Anthropic client for the features experiment. It mirrors
 * lib/ai-extract.mjs (same model, same JSON repair, same usage accounting) but
 * does not import its happy-hour prompt, and it clips page text from the top
 * rather than around "happy hour" — amenities are advertised in the About and
 * footer copy, not in the specials section.
 */
import { parseModelJson } from '../../import-google-venues/lib/ai-extract.mjs';
import { recordAiUsage } from '../../import-google-venues/lib/ai-usage.mjs';

const MODEL = process.env.VENUE_AI_MODEL?.trim() || 'claude-haiku-4-5';
const MAX_PAGE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 60_000;

export function buildSourceBlock(record) {
  const { venue, pages, social } = record;
  const parts = [
    'TARGET VENUE:',
    `- Name: ${venue.name}`,
    `- Address: ${venue.address}, ${venue.neighborhood}, San Diego County`,
    `- Website: ${venue.website}`,
    '',
  ];
  let remaining = MAX_TOTAL_CHARS;
  for (const [index, page] of pages.entries()) {
    const budget = Math.min(MAX_PAGE_CHARS, Math.max(1_500, Math.floor(remaining / (pages.length - index))));
    const body = page.text.slice(0, budget);
    remaining -= body.length;
    parts.push(`--- SOURCE ${index + 1} ---`, `URL: ${page.url}`, body, '');
    if (remaining < 800) break;
  }
  for (const account of social || []) {
    parts.push(`--- SOURCE (${account.network}) ---`, `URL: ${account.url}`, account.text.slice(0, 1_500), '');
  }
  return parts.join('\n');
}

export async function askAnthropic(system, userText, { purpose, maxTokens = 2048 } = {}) {
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
