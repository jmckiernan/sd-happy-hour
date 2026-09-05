import { createHash } from 'node:crypto';
import type {
  ContentSource,
  NormalizationResult,
  NormalizedContentItem,
  RawSourceItem,
} from './types';

const COUNTY_TERMS = [
  'san diego', 'carlsbad', 'chula vista', 'coronado', 'del mar', 'el cajon',
  'encinitas', 'escondido', 'imperial beach', 'la mesa', 'lemon grove',
  'national city', 'oceanside', 'poway', 'san marcos', 'santee', 'solana beach',
  'vista', 'fallbrook', 'ramona', 'julian', 'bonsall', 'alpine', 'lakeside',
  'spring valley', 'rancho santa fe', 'valley center', 'borrego springs',
  'north park', 'south park', 'hillcrest', 'gaslamp', 'little italy',
  'pacific beach', 'ocean beach', 'mission beach', 'mission valley', 'la jolla',
  'point loma', 'liberty station', 'normal heights', 'university heights',
  'kensington', 'clairemont', 'kearny mesa', 'convoy', 'mira mesa', 'miramar',
  'rancho bernardo', 'north county', 'east county', 'south bay', 'downtown',
  'balboa park', 'barrio logan', 'city heights', 'bankers hill', 'golden hill',
];

const OUTSIDE_COUNTY_TERMS = [
  'los angeles', 'orange county', 'riverside county', 'san bernardino',
  'palm springs', 'temecula', 'murrieta', 'irvine', 'anaheim', 'long beach',
  'tijuana', 'ensenada', 'las vegas', 'san francisco',
];

const EVENT_TYPE_KEYWORDS: Record<string, string[]> = {
  'happy-hour': ['happy hour', 'drink special', 'cocktail special'],
  'food-deal': ['food special', 'dining deal', 'prix fixe', 'restaurant week', 'taco tuesday', 'brunch special'],
  'live-music': ['live music', 'concert', 'band', 'dj set', 'album release'],
  comedy: ['comedy', 'comedian', 'stand-up', 'standup', 'improv'],
  nightlife: ['nightlife', 'dance party', 'club night', 'late night', 'rooftop party'],
  festival: ['festival', 'street fair', 'block party', 'artwalk', 'art walk'],
  tasting: ['tasting', 'beer fest', 'wine fest', 'brew fest'],
  'pop-up': ['pop-up', 'popup', 'makers market', 'night market'],
  theater: ['theatre', 'theater', 'musical', 'opera', 'play'],
  community: ['community event', 'farmers market', 'market', 'fundraiser'],
  opening: ['grand opening', 'now open', 'soft opening', 'reopening', 're-open'],
  'menu-update': ['new menu', 'seasonal menu', 'menu launch', 'menu update', 'new dishes'],
  'venue-news': ['venue news', 'announcement', 'announcing', 'expansion', 'new location'],
  seasonal: ['seasonal', 'summer menu', 'fall menu', 'winter menu', 'spring menu', 'holiday menu'],
};

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _match;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? _match;
  });
}

export function stripHtml(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

export function normalizeText(input: unknown): string {
  return stripHtml(String(input ?? '')).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function slugifyContent(input: string): string {
  return normalizeText(input)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 90);
}

function safeHttpUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ''));
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeIsoDate(value: unknown): string | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

export function inferEventTypes(input: string, supplied: string[] = []): string[] {
  const text = normalizeText(input).toLowerCase();
  const inferred = Object.entries(EVENT_TYPE_KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => text.includes(keyword)))
    .map(([type]) => type);
  return unique([...supplied.map(slugifyContent), ...inferred]);
}

function countyDecision(raw: RawSourceItem, source: ContentSource): {
  inCounty: boolean;
  area?: string | null;
  flags: string[];
} {
  const area = normalizeText(raw.neighborhood || raw.area || raw.address || source.config.defaultArea || '') || null;
  const geographicText = normalizeText([
    raw.county, raw.neighborhood, raw.area, raw.address, raw.venueName, raw.title, raw.description,
  ].filter(Boolean).join(' ')).toLowerCase();
  const hasCountyTerm = COUNTY_TERMS.some((term) => geographicText.includes(term));
  const hasOutsideTerm = OUTSIDE_COUNTY_TERMS.some((term) => geographicText.includes(term));
  const explicitSanDiegoCounty = normalizeText(raw.county).toLowerCase().includes('san diego');

  if (hasOutsideTerm && !hasCountyTerm && !explicitSanDiegoCounty) {
    return { inCounty: false, area, flags: ['outside_san_diego_county'] };
  }
  if (hasCountyTerm || explicitSanDiegoCounty) return { inCounty: true, area, flags: [] };
  if (source.countyScoped) return { inCounty: true, area, flags: ['location_unverified'] };
  return { inCounty: false, area, flags: ['location_unverified'] };
}

function canonicalKey(input: {
  title: string;
  venueName?: string | null;
  eventStartAt?: string | null;
  area?: string | null;
}): string {
  const dateKey = input.eventStartAt?.slice(0, 10) || 'undated';
  const basis = [
    slugifyContent(input.venueName || ''), slugifyContent(input.title), dateKey,
    slugifyContent(input.area || ''),
  ].join('|');
  return createHash('sha256').update(basis).digest('hex').slice(0, 40);
}

function configuredKeywordMatch(source: ContentSource, text: string): boolean {
  const include = source.config.includeKeywords?.map((value) => value.toLowerCase()).filter(Boolean) || [];
  const exclude = source.config.excludeKeywords?.map((value) => value.toLowerCase()).filter(Boolean) || [];
  const lower = text.toLowerCase();
  if (exclude.some((keyword) => lower.includes(keyword))) return false;
  return !include.length || include.some((keyword) => lower.includes(keyword));
}

export function normalizeSourceItem(
  source: ContentSource,
  raw: RawSourceItem,
  fetchedAt = new Date().toISOString()
): NormalizationResult {
  const url = safeHttpUrl(raw.url);
  const title = normalizeText(raw.title);
  const description = normalizeText(raw.description);
  if (!url) return { accepted: false, reason: 'invalid_source_url' };
  if (title.length < 4) return { accepted: false, reason: 'missing_title' };
  if (!configuredKeywordMatch(source, `${title} ${description}`)) {
    return { accepted: false, reason: 'source_keyword_filter' };
  }

  const location = countyDecision(raw, source);
  if (!location.inCounty) return { accepted: false, reason: 'outside_san_diego_county' };

  const venueName = normalizeText(raw.venueName || source.config.defaultVenue || '') || null;
  const eventStartAt = safeIsoDate(raw.startAt);
  const eventEndAt = safeIsoDate(raw.endAt);
  const sourcePublishedAt = safeIsoDate(raw.publishedAt);
  const neighborhood = normalizeText(raw.neighborhood) || null;
  const area = normalizeText(raw.area) || location.area || neighborhood;
  const address = normalizeText(raw.address) || null;
  const eventTypes = inferEventTypes(`${title} ${description}`, raw.eventTypes || []);
  const imageUrls = unique((raw.imageUrls || []).map(safeHttpUrl));
  const qualityFlags = [...location.flags];
  if (!eventStartAt) qualityFlags.push('missing_event_date');
  if (!venueName) qualityFlags.push('missing_venue');
  if (!description) qualityFlags.push('thin_description');
  if (!eventTypes.length) qualityFlags.push('unclassified');

  let confidence = source.trustScore * 0.64 + 0.13;
  if (eventStartAt) confidence += 0.09;
  if (venueName) confidence += 0.05;
  if (area || address) confidence += 0.05;
  if (description.length >= 80) confidence += 0.04;
  if (source.kind === 'reddit_rss') confidence = Math.min(confidence, 0.64);
  const isFirstPartyNewsletter = raw.tags?.some((tag) => slugifyContent(tag) === 'newsletter')
    && source.trustScore >= 0.8 && Boolean(venueName) && description.length >= 120;
  if (!eventStartAt) confidence = Math.min(confidence, isFirstPartyNewsletter ? 0.72 : 0.62);
  if (qualityFlags.includes('location_unverified')) confidence = Math.min(confidence, 0.65);
  confidence = Math.max(0.05, Math.min(0.98, confidence));

  const item: NormalizedContentItem = {
    canonicalKey: canonicalKey({ title, venueName, eventStartAt, area }),
    venueName,
    title,
    description,
    eventStartAt,
    eventEndAt,
    allDay: Boolean(raw.allDay),
    neighborhood,
    area,
    address,
    county: 'San Diego',
    confidenceScore: Number(confidence.toFixed(3)),
    status: confidence >= 0.72 ? 'accepted' : 'review',
    eventTypes,
    tags: unique([...(raw.tags || []).map(slugifyContent), ...eventTypes, area ? slugifyContent(area) : null]),
    imageUrls,
    qualityFlags: unique(qualityFlags),
    provenance: [{
      sourceId: source.id,
      sourceName: source.name,
      sourceKind: source.kind,
      sourceUrl: url,
      externalId: normalizeText(raw.externalId) || null,
      sourceTitle: title,
      sourceDescription: description,
      sourcePublishedAt,
      fetchedAt,
      imageUrls,
      attribution: normalizeText(raw.attribution || source.config.attribution || source.config.publisher || '') || null,
      trustScore: source.trustScore,
      imagePolicy: source.imagePolicy,
      raw: raw.raw || {},
    }],
  };

  return { accepted: true, item };
}
