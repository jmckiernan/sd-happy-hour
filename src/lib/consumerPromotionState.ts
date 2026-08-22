import type { PublicPromotionDto } from './promotionDtos';
import { PROMOTION_TYPES } from './promotionState';
import {
  getActiveHappyHourOccurrence,
  parseInstant,
  type HappyHourOccurrence,
  type HappyHourSchedule,
  type InstantInput,
} from './sanDiegoTime';

export type PublicLivePromotion = PublicPromotionDto;

export interface LivePromotionsResponse {
  serverNow: string;
  promotions: PublicLivePromotion[];
}

export type ConsumerActivityState =
  | 'neither'
  | 'happy-hour-only'
  | 'live-deal-only'
  | 'both';

export interface ConsumerPromotionState {
  state: ConsumerActivityState;
  happyHourOccurrence: HappyHourOccurrence | null;
  liveDeals: readonly PublicLivePromotion[];
}

export interface ConsumerPromotionStateInput {
  venueId: number;
  schedule?: HappyHourSchedule | null;
  promotions: readonly PublicLivePromotion[];
  /** Pass the public feed's server-anchored clock value, never device time. */
  now: InstantInput;
}

export type DealCodeState =
  | { kind: 'none' }
  | { kind: 'gated' }
  | { kind: 'revealed'; code: string };

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface LiveDealDiscoveryIntent {
  neighborhood?: string | null;
  query?: string | null;
  radius?: {
    center: GeoPoint;
    miles: number;
  } | null;
}

/** Directory-only data can extend discovery without coupling this module to venue storage. */
export interface LiveDealDiscoverySources {
  venueSearchText?: (
    venueId: number
  ) => string | readonly string[] | null | undefined;
  venueCoordinates?: (venueId: number) => GeoPoint | null | undefined;
  distanceMiles?: (from: GeoPoint, to: GeoPoint) => number;
}

const PUBLIC_PROMOTION_TYPES: ReadonlySet<string> = new Set(PROMOTION_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Runtime guard for the session-sensitive public API boundary. */
export function isPublicLivePromotion(value: unknown): value is PublicLivePromotion {
  if (!isRecord(value) || !isRecord(value.venue)) return false;
  const venue = value.venue;
  const startsAt = parseInstant(value.startsAt as InstantInput);
  const endsAt = parseInstant(value.endsAt as InstantInput);
  const effectiveEndsAt = parseInstant(value.effectiveEndsAt as InstantInput);
  return (
    isNonEmptyString(value.id) &&
    Number.isSafeInteger(value.venueId) &&
    (value.venueId as number) > 0 &&
    value.venueId === venue.id &&
    Number.isSafeInteger(venue.id) &&
    (venue.id as number) > 0 &&
    isNonEmptyString(venue.name) &&
    isNonEmptyString(venue.slug) &&
    typeof venue.neighborhood === 'string' &&
    typeof venue.image === 'string' &&
    typeof value.type === 'string' &&
    PUBLIC_PROMOTION_TYPES.has(value.type) &&
    isNonEmptyString(value.title) &&
    typeof value.description === 'string' &&
    value.state === 'live' &&
    typeof value.hasDealCode === 'boolean' &&
    (
      value.hasDealCode
        ? !hasOwn(value, 'dealCode') || isNonEmptyString(value.dealCode)
        : !hasOwn(value, 'dealCode') || value.dealCode === null
    ) &&
    startsAt !== null &&
    endsAt !== null &&
    effectiveEndsAt !== null &&
    startsAt.getTime() < effectiveEndsAt.getTime() &&
    effectiveEndsAt.getTime() <= endsAt.getTime()
  );
}

/** Promotion state uses the same half-open interval as the Phase 2 backend. */
export function isPublicPromotionLiveAt(
  promotion: PublicLivePromotion,
  now: InstantInput
): boolean {
  if (promotion.state !== 'live') return false;
  const instant = parseInstant(now);
  const startsAt = parseInstant(promotion.startsAt);
  const effectiveEndsAt = parseInstant(promotion.effectiveEndsAt);
  if (!instant || !startsAt || !effectiveEndsAt) return false;
  return instant.getTime() >= startsAt.getTime() && instant.getTime() < effectiveEndsAt.getTime();
}

export function deriveConsumerPromotionState(
  input: ConsumerPromotionStateInput
): ConsumerPromotionState {
  const now = parseInstant(input.now);
  if (!now) throw new RangeError('Expected a valid absolute instant.');
  const happyHourOccurrence = input.schedule?.id === input.venueId
    ? getActiveHappyHourOccurrence(input.schedule, now)
    : null;
  const liveDeals = input.promotions.filter(
    (promotion) =>
      promotion.venueId === input.venueId && isPublicPromotionLiveAt(promotion, now)
  );
  const hasHappyHour = happyHourOccurrence !== null;
  const hasLiveDeal = liveDeals.length > 0;

  let state: ConsumerActivityState = 'neither';
  if (hasHappyHour && hasLiveDeal) state = 'both';
  else if (hasHappyHour) state = 'happy-hour-only';
  else if (hasLiveDeal) state = 'live-deal-only';

  return { state, happyHourOccurrence, liveDeals };
}

export function classifyDealCode(promotion: PublicLivePromotion): DealCodeState {
  if (!promotion.hasDealCode) return { kind: 'none' };
  if (hasOwn(promotion, 'dealCode') && isNonEmptyString(promotion.dealCode)) {
    return { kind: 'revealed', code: promotion.dealCode.trim() };
  }
  return { kind: 'gated' };
}

/** Remove session-only secrets before an authentication transition can repaint. */
export function redactPromotionDealCodes(
  promotions: readonly PublicLivePromotion[]
): PublicLivePromotion[] {
  return promotions.map((promotion) => {
    const redacted = { ...promotion };
    delete redacted.dealCode;
    return redacted;
  });
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isValidPoint(point: GeoPoint | null | undefined): point is GeoPoint {
  return Boolean(
    point &&
      Number.isFinite(point.latitude) &&
      point.latitude >= -90 &&
      point.latitude <= 90 &&
      Number.isFinite(point.longitude) &&
      point.longitude >= -180 &&
      point.longitude <= 180
  );
}

function haversineMiles(from: GeoPoint, to: GeoPoint): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const fromLatitude = radians(from.latitude);
  const toLatitude = radians(to.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * 3958.7613 * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function supplementalSearchText(
  venueId: number,
  source: LiveDealDiscoverySources['venueSearchText']
): readonly string[] {
  const value = source?.(venueId);
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Apply only search and explicit geographic intent to Live Deals. This API
 * deliberately has no recurring schedule/day/status filter inputs.
 */
export function filterLiveDealsForDiscovery(
  promotions: readonly PublicLivePromotion[],
  intent: LiveDealDiscoveryIntent,
  sources: LiveDealDiscoverySources = {}
): PublicLivePromotion[] {
  const neighborhood = normalizeSearchText(intent.neighborhood ?? '');
  const queryTerms = normalizeSearchText(intent.query ?? '').split(' ').filter(Boolean);
  const radius = intent.radius ?? null;
  if (
    radius &&
    (!isValidPoint(radius.center) || !Number.isFinite(radius.miles) || radius.miles < 0)
  ) {
    throw new RangeError('Expected a valid center and non-negative radius.');
  }
  const distanceMiles = sources.distanceMiles ?? haversineMiles;

  return promotions.filter((promotion) => {
    if (
      neighborhood &&
      normalizeSearchText(promotion.venue.neighborhood) !== neighborhood
    ) {
      return false;
    }

    if (queryTerms.length) {
      const searchText = normalizeSearchText(
        [
          promotion.title,
          promotion.description,
          promotion.type.replaceAll('_', ' '),
          promotion.venue.name,
          promotion.venue.neighborhood,
          ...supplementalSearchText(promotion.venueId, sources.venueSearchText),
        ].join(' ')
      );
      if (!queryTerms.every((term) => searchText.includes(term))) return false;
    }

    if (radius) {
      const coordinates = sources.venueCoordinates?.(promotion.venueId);
      if (!isValidPoint(coordinates)) return false;
      const distance = distanceMiles(radius.center, coordinates);
      if (!Number.isFinite(distance) || distance < 0 || distance > radius.miles) return false;
    }

    return true;
  });
}
