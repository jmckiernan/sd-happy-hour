import type { NormalizedContentItem } from './types';
import { normalizeText, slugifyContent } from './normalize';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the',
  'to', 'with', 'san', 'diego', 'event', 'events',
]);

function tokens(value: string): Set<string> {
  return new Set(
    slugifyContent(value).split('-').filter((token) => token.length > 1 && !STOP_WORDS.has(token))
  );
}

export function tokenSimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return normalizeText(left).toLowerCase() === normalizeText(right).toLowerCase() ? 1 : 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function tokenContainment(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.min(a.size, b.size);
}

function dateDistanceDays(left?: string | null, right?: string | null): number | null {
  if (!left || !right) return null;
  return Math.abs(new Date(left).valueOf() - new Date(right).valueOf()) / 86_400_000;
}

export function duplicateScore(left: NormalizedContentItem, right: NormalizedContentItem): number {
  if (left.canonicalKey === right.canonicalKey) return 1;
  const days = dateDistanceDays(left.eventStartAt, right.eventStartAt);
  if (days !== null && days > 1) return 0;

  const titleContainment = tokenContainment(left.title, right.title);
  const title = Math.max(
    tokenSimilarity(left.title, right.title),
    titleContainment * 0.92
  );
  const venue = left.venueName && right.venueName
    ? tokenSimilarity(left.venueName, right.venueName)
    : 0.45;
  const area = left.area && right.area ? tokenSimilarity(left.area, right.area) : 0.45;
  const date = days === null ? 0.35 : days <= 0.08 ? 1 : days <= 1 ? 0.7 : 0;
  let score = title * 0.52 + venue * 0.24 + date * 0.18 + area * 0.06;
  // Publishers often prepend a neighborhood or append "at Venue" to the
  // same event name. An exact date + near-exact venue makes that containment
  // pattern materially stronger than raw title Jaccard alone.
  if (days !== null && days <= 0.08 && venue >= 0.85 && titleContainment >= 0.5) score += 0.09;

  // Undated items need a near-exact semantic match; otherwise recurring
  // events with the same name would collapse into one permanent record.
  if (days === null && score < 0.88) return 0;
  return Number(score.toFixed(3));
}

export function findDuplicate(
  item: NormalizedContentItem,
  candidates: NormalizedContentItem[],
  threshold = 0.78
): { item: NormalizedContentItem; score: number } | null {
  let best: { item: NormalizedContentItem; score: number } | null = null;
  for (const candidate of candidates) {
    const score = duplicateScore(item, candidate);
    if (score >= threshold && (!best || score > best.score)) best = { item: candidate, score };
  }
  return best;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function preferLonger(left?: string | null, right?: string | null): string | null {
  if (!left) return right || null;
  if (!right) return left;
  return right.length > left.length ? right : left;
}

export function mergeContentItems(
  existing: NormalizedContentItem,
  incoming: NormalizedContentItem
): NormalizedContentItem {
  const provenance = [...existing.provenance];
  for (const source of incoming.provenance) {
    if (!provenance.some((item) => item.sourceUrl === source.sourceUrl)) provenance.push(source);
  }
  const sourceCount = new Set(provenance.map((source) => source.sourceId)).size;
  const confidence = Math.min(
    0.99,
    Math.max(existing.confidenceScore, incoming.confidenceScore) + Math.min(0.12, (sourceCount - 1) * 0.05)
  );
  const flags = unique([...existing.qualityFlags, ...incoming.qualityFlags]);
  if (sourceCount > 1) {
    const index = flags.indexOf('single_source');
    if (index >= 0) flags.splice(index, 1);
  }

  return {
    ...existing,
    venueName: preferLonger(existing.venueName, incoming.venueName),
    title: preferLonger(existing.title, incoming.title) || existing.title,
    description: preferLonger(existing.description, incoming.description) || '',
    eventStartAt: existing.eventStartAt || incoming.eventStartAt,
    eventEndAt: existing.eventEndAt || incoming.eventEndAt,
    allDay: existing.allDay && incoming.allDay,
    neighborhood: preferLonger(existing.neighborhood, incoming.neighborhood),
    area: preferLonger(existing.area, incoming.area),
    address: preferLonger(existing.address, incoming.address),
    confidenceScore: Number(confidence.toFixed(3)),
    status: confidence >= 0.72 ? 'accepted' : 'review',
    eventTypes: unique([...existing.eventTypes, ...incoming.eventTypes]),
    tags: unique([...existing.tags, ...incoming.tags]),
    imageUrls: unique([...existing.imageUrls, ...incoming.imageUrls]),
    qualityFlags: flags,
    provenance,
    lastSeenAt: new Date().toISOString(),
  };
}
