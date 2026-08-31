/** Claim-dashboard search: every query token must appear in name, neighborhood, or address.
 *
 * Deliberately not the same haystack as the consumer search in index.astro: an
 * owner is looking for their own venue by name, so matching on menu text would
 * only add venues that happen to sell a similarly named dish. */

const STOP = new Set(['the', 'and', 'of', 'at', 'a', 'an']);

function normalize(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function searchTokens(query: string): string[] {
  return normalize(query).split(/\s+/).filter((token) => token.length >= 2 && !STOP.has(token));
}

export function venueSearchScore(
  venue: { name?: string; neighborhood?: string; address?: string },
  query: string
): number {
  const tokens = searchTokens(query);
  if (!tokens.length) return 0;
  const name = normalize(venue.name || '');
  const extra = normalize(`${venue.neighborhood || ''} ${venue.address || ''}`);
  const haystack = `${name} ${extra}`.trim();
  if (!tokens.every((token) => haystack.includes(token))) return 0;

  let score = 0;
  for (const token of tokens) {
    score += name.includes(token) ? 10 : 1;
  }
  const collapsed = normalize(query).replace(/\s+/g, '');
  if (collapsed.length >= 4 && name.replace(/\s+/g, '').includes(collapsed)) score += 20;
  return score;
}

export function venueMatchesQuery(
  venue: { name?: string; neighborhood?: string; address?: string },
  query: string
): boolean {
  return venueSearchScore(venue, query) > 0;
}
