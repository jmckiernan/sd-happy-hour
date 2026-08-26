import { createHash } from 'node:crypto';
import type { ClusterType, EditorialCluster, NormalizedContentItem } from './types';
import { normalizeText, slugifyContent } from './normalize';

const PACIFIC_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});
const FRIENDLY_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
});

function localDateKey(value?: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? PACIFIC_DATE.format(parsed) : null;
}

function friendlyDate(value?: string | null): string {
  return value ? FRIENDLY_DATE.format(new Date(value)) : 'an upcoming date';
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function signature(type: ClusterType, items: NormalizedContentItem[], discriminator = ''): string {
  const ids = items.map((item) => item.id || item.canonicalKey).sort().join('|');
  return createHash('sha256').update(`${type}|${discriminator}|${ids}`).digest('hex').slice(0, 40);
}

function sourceCount(items: NormalizedContentItem[]): number {
  return new Set(items.flatMap((item) => item.provenance.map((source) => source.sourceId))).size;
}

function score(items: NormalizedContentItem[], specificity = 0.7): { editorial: number; confidence: number } {
  const average = items.reduce((sum, item) => sum + item.confidenceScore, 0) / Math.max(1, items.length);
  const corroboration = Math.min(0.12, Math.max(0, sourceCount(items) - 1) * 0.03);
  const usefulVolume = Math.min(0.13, Math.max(0, items.length - 1) * 0.035);
  return {
    confidence: Number(Math.min(0.99, average + corroboration).toFixed(3)),
    editorial: Number(Math.min(0.99, average * 0.58 + specificity * 0.25 + usefulVolume + corroboration).toFixed(3)),
  };
}

function createCluster(input: {
  type: ClusterType;
  items: NormalizedContentItem[];
  angle: string;
  title: string;
  summary: string;
  discriminator?: string;
  specificity?: number;
  tags?: string[];
}): EditorialCluster {
  const sorted = [...input.items].sort((a, b) => String(a.eventStartAt).localeCompare(String(b.eventStartAt)));
  const values = score(sorted, input.specificity);
  return {
    angle: input.angle,
    workingTitle: input.title,
    summary: input.summary,
    clusterType: input.type,
    editorialScore: values.editorial,
    confidenceScore: values.confidence,
    eventStartAt: sorted.find((item) => item.eventStartAt)?.eventStartAt || null,
    eventEndAt: [...sorted].reverse().find((item) => item.eventEndAt || item.eventStartAt)?.eventEndAt
      || [...sorted].reverse().find((item) => item.eventStartAt)?.eventStartAt
      || null,
    tags: unique([...(input.tags || []), ...sorted.flatMap((item) => item.tags)]).map(slugifyContent),
    signature: signature(input.type, sorted, input.discriminator),
    items: sorted,
  };
}

function weekendKey(item: NormalizedContentItem): string | null {
  if (!item.eventStartAt) return null;
  const date = new Date(item.eventStartAt);
  const weekday = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short',
  }).formatToParts(date).find((part) => part.type === 'weekday')?.value === 'Sun' ? 0 : date.getUTCDay());
  const pacificDate = new Date(`${localDateKey(item.eventStartAt)}T12:00:00-07:00`);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' }).format(pacificDate);
  const offset = day === 'Fri' ? 0 : day === 'Sat' ? -1 : day === 'Sun' ? -2 : null;
  if (offset === null) return null;
  pacificDate.setUTCDate(pacificDate.getUTCDate() + offset);
  void weekday;
  return PACIFIC_DATE.format(pacificDate);
}

function groupBy(items: NormalizedContentItem[], key: (item: NormalizedContentItem) => string | null) {
  const groups = new Map<string, NormalizedContentItem[]>();
  for (const item of items) {
    const value = key(item);
    if (!value) continue;
    groups.set(value, [...(groups.get(value) || []), item]);
  }
  return groups;
}

function editorialSubset(items: NormalizedContentItem[], limit: number): NormalizedContentItem[] {
  return [...items].sort((left, right) => {
    const usefulness = (item: NormalizedContentItem) =>
      item.confidenceScore * 10
      + (item.venueName ? 1 : 0)
      + (item.area || item.neighborhood ? 1 : 0)
      + (item.description.length >= 100 ? 1 : 0)
      + (item.eventTypes.length ? 1 : 0)
      - item.qualityFlags.length * 0.4;
    return usefulness(right) - usefulness(left);
  }).slice(0, limit);
}

export function buildEditorialClusters(
  candidates: NormalizedContentItem[],
  options: { minItemConfidence?: number; minClusterScore?: number } = {}
): EditorialCluster[] {
  const minItem = options.minItemConfidence ?? 0.55;
  const minCluster = options.minClusterScore ?? 0.62;
  const items = candidates.filter((item) =>
    item.confidenceScore >= minItem && item.status !== 'rejected' && item.status !== 'expired'
  );
  const proposals: EditorialCluster[] = [];

  for (const [date, grouped] of groupBy(items, (item) => localDateKey(item.eventStartAt))) {
    if (grouped.length < 3) continue;
    const selected = editorialSubset(grouped, 8);
    proposals.push(createCluster({
      type: 'date_roundup', items: selected,
      angle: `A practical same-day guide connecting ${selected.length} distinct San Diego options.`,
      title: `Things to Do in San Diego on ${friendlyDate(selected[0].eventStartAt)}`,
      summary: `A date-specific roundup built from ${selected.length} current event or deal records.`,
      discriminator: date, specificity: 0.9, tags: [date, 'things-to-do'],
    }));
  }

  for (const [friday, grouped] of groupBy(items, weekendKey)) {
    if (grouped.length < 3) continue;
    const selected = editorialSubset(grouped, 10);
    proposals.push(createCluster({
      type: 'weekend_roundup', items: selected,
      angle: 'A useful weekend itinerary spanning food, drinks, entertainment, and local events.',
      title: `What to Do in San Diego This Weekend: ${friday}`,
      summary: `A weekend bundle of ${selected.length} timely San Diego possibilities.`,
      discriminator: friday, specificity: 0.86, tags: [friday, 'weekend', 'things-to-do'],
    }));
  }

  for (const [area, grouped] of groupBy(items, (item) => slugifyContent(item.neighborhood || item.area || '') || null)) {
    if (grouped.length < 3) continue;
    const selected = editorialSubset(grouped, 8);
    const label = grouped.find((item) => item.neighborhood || item.area)?.neighborhood
      || grouped.find((item) => item.area)?.area || area;
    proposals.push(createCluster({
      type: 'neighborhood_roundup', items: selected,
      angle: `A locally specific guide that helps readers plan a night around ${label}.`,
      title: `${label} Events, Dining Deals, and Nightlife`,
      summary: `${selected.length} current ideas tied together by one San Diego County area.`,
      discriminator: area, specificity: 0.88, tags: [area, 'neighborhood-guide'],
    }));
  }

  for (const [eventType, grouped] of groupBy(items, (item) => item.eventTypes[0] || null)) {
    if (grouped.length < 3) continue;
    const selected = editorialSubset(grouped, 8);
    const label = eventType.replace(/-/g, ' ');
    proposals.push(createCluster({
      type: 'event_type_roundup', items: selected,
      angle: `Compare several timely ${label} options across San Diego County.`,
      title: `San Diego ${label.replace(/\b\w/g, (char) => char.toUpperCase())}: Current Picks`,
      summary: `${selected.length} related options with dates, locations, and source links.`,
      discriminator: eventType, specificity: 0.8, tags: [eventType],
    }));
  }

  // High-signal discoveries can stand alone; low-confidence social posts
  // never qualify for this path without corroboration raising the item score.
  for (const item of items.filter((candidate) =>
    candidate.confidenceScore >= 0.82 && Boolean(candidate.eventStartAt) && candidate.description.length >= 80
  )) {
    proposals.push(createCluster({
      type: 'single', items: [item],
      angle: `A focused, source-grounded preview of ${item.title}.`,
      title: item.title,
      summary: item.description.slice(0, 260),
      discriminator: item.canonicalKey, specificity: 0.84,
      tags: item.tags,
    }));
  }

  // Prefer the strongest, most useful bundle and avoid generating several
  // near-identical stories from the same set of inputs in one run.
  const selected: EditorialCluster[] = [];
  const usedSignatures = new Set<string>();
  const claimedItemSets: Array<Set<string>> = [];
  for (const proposal of proposals.sort((a, b) => b.editorialScore - a.editorialScore)) {
    if (proposal.editorialScore < minCluster || usedSignatures.has(proposal.signature)) continue;
    const ids = new Set(proposal.items.map((item) => item.id || item.canonicalKey));
    const tooSimilar = claimedItemSets.some((claimed) => {
      const overlap = [...ids].filter((id) => claimed.has(id)).length;
      return overlap / Math.min(ids.size, claimed.size) >= 0.8;
    });
    if (tooSimilar) continue;
    selected.push(proposal);
    claimedItemSets.push(ids);
    usedSignatures.add(proposal.signature);
  }
  return selected;
}
