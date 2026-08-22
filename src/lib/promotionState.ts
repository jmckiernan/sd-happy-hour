import { parseInstant, type InstantInput } from './sanDiegoTime';

export const PROMOTION_TYPES = ['special_deal', 'extended_happy_hour', 'event', 'other'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export const PROMOTION_STATES = ['draft', 'scheduled', 'live', 'ended', 'cancelled'] as const;
export type PromotionState = (typeof PROMOTION_STATES)[number];

/** MVP rule: one published promotion window per venue may overlap a time. */
export const MAX_OVERLAPPING_PROMOTIONS_PER_VENUE = 1;

/**
 * Minimal structural shape accepted by the state helpers. Storage owns the
 * full promotion entity; these helpers only need lifecycle timestamps.
 *
 * `publishedAt` distinguishes an intentionally unpublished draft from a
 * scheduled promotion. Scheduled/live/ended are derived from the time window,
 * while explicit cancellation always wins.
 */
export interface PromotionStateInput {
  id?: string;
  startsAt?: InstantInput | null;
  endsAt?: InstantInput | null;
  publishedAt?: InstantInput | null;
  endedAt?: InstantInput | null;
  cancelledAt?: InstantInput | null;
}

function validInstant(value: InstantInput | null | undefined): Date | null {
  return parseInstant(value);
}

function isCancelled(promotion: PromotionStateInput): boolean {
  return validInstant(promotion.cancelledAt) !== null;
}

/**
 * The scheduled end remains immutable historical intent. Ending a promotion
 * early records `endedAt`; consumers use whichever valid end occurred first.
 */
export function getEffectivePromotionEnd(promotion: PromotionStateInput): Date | null {
  const scheduledEnd = validInstant(promotion.endsAt);
  const endedAt = validInstant(promotion.endedAt);
  if (!scheduledEnd) return endedAt;
  if (!endedAt) return scheduledEnd;
  return endedAt.getTime() < scheduledEnd.getTime() ? endedAt : scheduledEnd;
}

export function getPromotionState(
  promotion: PromotionStateInput,
  now: InstantInput = new Date()
): PromotionState {
  if (isCancelled(promotion)) return 'cancelled';

  // Legacy promotions intentionally migrate with no publication timestamp or
  // timing. Even if malformed data happens to carry a window, unpublished
  // inventory remains a draft and can never become live by accident.
  if (!validInstant(promotion.publishedAt)) return 'draft';

  const startsAt = validInstant(promotion.startsAt);
  const endsAt = getEffectivePromotionEnd(promotion);
  if (!startsAt || !endsAt || endsAt.getTime() <= startsAt.getTime()) return 'draft';

  const instant = validInstant(now);
  if (!instant) throw new RangeError('Expected a valid absolute instant.');
  if (instant.getTime() < startsAt.getTime()) return 'scheduled';
  if (instant.getTime() < endsAt.getTime()) return 'live';
  return 'ended';
}

export function isPromotionLive(promotion: PromotionStateInput, now: InstantInput = new Date()): boolean {
  return getPromotionState(promotion, now) === 'live';
}

function promotionWindow(
  promotion: PromotionStateInput
): { start: Date; end: Date } | null {
  if (isCancelled(promotion) || !validInstant(promotion.publishedAt)) return null;
  const start = validInstant(promotion.startsAt);
  const end = getEffectivePromotionEnd(promotion);
  if (!start || !end || end.getTime() <= start.getTime()) return null;
  return { start, end };
}

/** Half-open windows overlap exactly when `a.start < b.end && b.start < a.end`. */
export function promotionWindowsOverlap(
  left: PromotionStateInput,
  right: PromotionStateInput
): boolean {
  const leftWindow = promotionWindow(left);
  const rightWindow = promotionWindow(right);
  if (!leftWindow || !rightWindow) return false;
  return (
    leftWindow.start.getTime() < rightWindow.end.getTime() &&
    rightWindow.start.getTime() < leftWindow.end.getTime()
  );
}

/**
 * Find the first conflicting promotion window. The candidate's own id is
 * ignored so an edit can check the venue's complete promotion list directly.
 */
export function findPromotionWindowConflict<T extends PromotionStateInput>(
  candidate: PromotionStateInput,
  promotions: readonly T[]
): T | null {
  return (
    promotions.find(
      (promotion) =>
        (!candidate.id || !promotion.id || promotion.id !== candidate.id) &&
        promotionWindowsOverlap(candidate, promotion)
    ) || null
  );
}
