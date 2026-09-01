export interface MatchableFeatureRequest {
  id: string;
  title: string;
  details: string;
  voteCount: number;
  status: string;
}

export interface FeatureRequestMatch<T extends MatchableFeatureRequest = MatchableFeatureRequest> {
  request: T;
  score: number;
}

const STOP_WORDS = new Set([
  'and', 'are', 'but', 'can', 'for', 'from', 'have', 'into', 'our', 'that',
  'the', 'their', 'this', 'user', 'users', 'want', 'with', 'would', 'you',
]);

export function normalizeFeedbackText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function meaningfulTokens(value: string): Set<string> {
  return new Set(normalizeFeedbackText(value).split(' ').filter((token) => token.length >= 3 && !STOP_WORDS.has(token)));
}

export function findFeatureRequestMatches<T extends MatchableFeatureRequest>(
  query: string,
  requests: T[],
  limit = 5,
): FeatureRequestMatch<T>[] {
  const normalizedQuery = normalizeFeedbackText(query);
  const queryTokens = meaningfulTokens(normalizedQuery);
  if (normalizedQuery.length < 4 || queryTokens.size === 0) return [];

  return requests
    .filter((request) => request.status === 'open' || request.status === 'planned')
    .map((request) => {
      const title = normalizeFeedbackText(request.title);
      const full = normalizeFeedbackText(`${request.title} ${request.details}`);
      const requestTokens = meaningfulTokens(full);
      const shared = [...queryTokens].filter((token) => requestTokens.has(token)).length;
      const overlap = shared / queryTokens.size;
      const score = title === normalizedQuery
        ? 3
        : title.includes(normalizedQuery) || normalizedQuery.includes(title)
          ? 2
          : overlap;
      return { request, score };
    })
    .filter((match) => match.score >= .35)
    .sort((left, right) =>
      right.score - left.score
      || right.request.voteCount - left.request.voteCount
      || left.request.title.localeCompare(right.request.title)
    )
    .slice(0, limit);
}
