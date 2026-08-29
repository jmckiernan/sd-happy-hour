/**
 * Token accounting for the Anthropic calls the importer makes.
 *
 * Without this, "the run cost $10" can only be attributed by guesswork, and
 * the guesses are wrong: attention goes to the visibly expensive-looking thing
 * (a 39MB PDF) when the bill is actually a per-venue text payload multiplied by
 * 611 listings. Every call records what it spent and on whose behalf, so a run
 * can say where the money went.
 *
 * Prices are USD per million tokens and can be overridden with
 * VENUE_AI_PRICE_INPUT / VENUE_AI_PRICE_OUTPUT when a model's rates change.
 */

const PRICES = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
};

const DEFAULT_PRICE = PRICES['claude-haiku-4-5'];

function priceFor(model) {
  const base = PRICES[model] || DEFAULT_PRICE;
  return {
    ...base,
    input: Number(process.env.VENUE_AI_PRICE_INPUT) || base.input,
    output: Number(process.env.VENUE_AI_PRICE_OUTPUT) || base.output,
  };
}

const totals = new Map();

function bucket(purpose) {
  if (!totals.has(purpose)) {
    totals.set(purpose, {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      imageBlocks: 0,
      imageBytes: 0,
      costUsd: 0,
    });
  }
  return totals.get(purpose);
}

/**
 * @param {string} purpose which pass spent this — 'extract', 'menu-board', …
 * @param {object} usage the API's `usage` object
 * @param {{ model?: string, imageBlocks?: number, imageBytes?: number }} context
 */
export function recordAiUsage(purpose, usage, context = {}) {
  const row = bucket(purpose);
  const price = priceFor(context.model);
  const input = Number(usage?.input_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  const cacheWrite = Number(usage?.cache_creation_input_tokens) || 0;
  const cacheRead = Number(usage?.cache_read_input_tokens) || 0;

  row.calls += 1;
  row.inputTokens += input;
  row.outputTokens += output;
  row.cacheWriteTokens += cacheWrite;
  row.cacheReadTokens += cacheRead;
  row.imageBlocks += Number(context.imageBlocks) || 0;
  row.imageBytes += Number(context.imageBytes) || 0;
  row.costUsd += (input / 1e6) * price.input
    + (output / 1e6) * price.output
    + (cacheWrite / 1e6) * price.cacheWrite
    + (cacheRead / 1e6) * price.cacheRead;
  return row;
}

export function aiUsageTotals() {
  const rows = [...totals.entries()].map(([purpose, row]) => ({ purpose, ...row }));
  const all = rows.reduce(
    (sum, row) => ({
      calls: sum.calls + row.calls,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      imageBlocks: sum.imageBlocks + row.imageBlocks,
      costUsd: sum.costUsd + row.costUsd,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, imageBlocks: 0, costUsd: 0 }
  );
  return { rows: rows.sort((a, b) => b.costUsd - a.costUsd), all };
}

export function formatAiUsage({ venues = 0 } = {}) {
  const { rows, all } = aiUsageTotals();
  if (!all.calls) return 'AI usage: no model calls.';

  const lines = ['--- AI usage ---'];
  for (const row of rows) {
    const perCall = row.calls ? row.costUsd / row.calls : 0;
    lines.push(
      `  ${row.purpose.padEnd(12)} ${String(row.calls).padStart(4)} call(s)  `
      + `in ${row.inputTokens.toLocaleString()} / out ${row.outputTokens.toLocaleString()} tok  `
      + `${row.imageBlocks} image(s)  $${row.costUsd.toFixed(4)}  ($${perCall.toFixed(4)}/call)`
    );
  }
  lines.push(
    `  total        ${String(all.calls).padStart(4)} call(s)  `
    + `in ${all.inputTokens.toLocaleString()} / out ${all.outputTokens.toLocaleString()} tok  `
    + `$${all.costUsd.toFixed(4)}`
  );
  if (venues > 0) {
    lines.push(`  per venue    $${(all.costUsd / venues).toFixed(4)}  →  611 listings ≈ $${((all.costUsd / venues) * 611).toFixed(2)}`);
  }
  return lines.join('\n');
}

export function resetAiUsage() {
  totals.clear();
}
