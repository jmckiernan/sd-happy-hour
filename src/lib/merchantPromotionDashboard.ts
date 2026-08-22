import {
  formatCountdown,
  formatSanDiegoTime,
  resolveSanDiegoDateTimeLocal,
} from './promotionClientTime';
import {
  getHappyHourOccurrenceForDate,
  getSanDiegoDateKey,
  parseInstant,
  type HappyHourSchedule,
  type InstantInput,
} from './sanDiegoTime';
import type {
  MerchantPromotionDto as ApiMerchantPromotionDto,
  PromotionActionsDto,
} from './promotionDtos';
import type {
  PromotionAllowance,
  PromotionEntitlement as ApiPromotionEntitlement,
  PromotionPlan,
} from './promotionEntitlements';
import type { PromotionState, PromotionType } from './promotionState';

/** Browser-facing aliases for the exact DTOs returned by the merchant APIs. */
export type MerchantPromotionDto = ApiMerchantPromotionDto;
export type MerchantPromotionEntitlementDto = ApiPromotionEntitlement;
export type PromotionEntitlementDto = ApiPromotionEntitlement;
export type {
  HappyHourSchedule,
  PromotionActionsDto,
  PromotionAllowance,
  PromotionPlan,
  PromotionState,
  PromotionType,
};

export interface MerchantPromotionsListDto {
  serverNow: string;
  venueId: number;
  promotions: MerchantPromotionDto[];
  entitlement: MerchantPromotionEntitlementDto;
}

export interface MerchantPromotionMutationDto {
  serverNow: string;
  promotion: MerchantPromotionDto;
  entitlement: MerchantPromotionEntitlementDto;
}

export interface GroupedMerchantPromotions<T extends MerchantPromotionDto = MerchantPromotionDto> {
  /** Promotions whose backend-provided state is `live`. */
  active: T[];
  scheduled: T[];
  drafts: T[];
  /** Promotions whose backend-provided state is `ended` or `cancelled`. */
  past: T[];
}

function instantMilliseconds(value: InstantInput | null | undefined): number | null {
  return parseInstant(value)?.getTime() ?? null;
}

function compareNullableInstants(
  left: InstantInput | null | undefined,
  right: InstantInput | null | undefined,
  direction: 'ascending' | 'descending'
): number {
  const leftTime = instantMilliseconds(left);
  const rightTime = instantMilliseconds(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return direction === 'ascending' ? leftTime - rightTime : rightTime - leftTime;
}

function compareId(left: MerchantPromotionDto, right: MerchantPromotionDto): number {
  return left.id.localeCompare(right.id);
}

function compareActive(left: MerchantPromotionDto, right: MerchantPromotionDto): number {
  return (
    compareNullableInstants(
      left.effectiveEndsAt ?? left.endsAt,
      right.effectiveEndsAt ?? right.endsAt,
      'ascending'
    ) ||
    compareNullableInstants(left.startsAt, right.startsAt, 'ascending') ||
    compareId(left, right)
  );
}

function compareScheduled(left: MerchantPromotionDto, right: MerchantPromotionDto): number {
  return (
    compareNullableInstants(left.startsAt, right.startsAt, 'ascending') ||
    compareNullableInstants(
      left.effectiveEndsAt ?? left.endsAt,
      right.effectiveEndsAt ?? right.endsAt,
      'ascending'
    ) ||
    compareId(left, right)
  );
}

function compareDrafts(left: MerchantPromotionDto, right: MerchantPromotionDto): number {
  return (
    compareNullableInstants(left.updatedAt, right.updatedAt, 'descending') ||
    compareNullableInstants(left.createdAt, right.createdAt, 'descending') ||
    compareId(left, right)
  );
}

function pastActivityAt(promotion: MerchantPromotionDto): InstantInput | null {
  if (promotion.state === 'cancelled') {
    return promotion.cancelledAt ?? promotion.updatedAt;
  }
  return (
    promotion.endedAt ??
    promotion.effectiveEndsAt ??
    promotion.endsAt ??
    promotion.updatedAt
  );
}

function comparePast(left: MerchantPromotionDto, right: MerchantPromotionDto): number {
  return (
    compareNullableInstants(pastActivityAt(left), pastActivityAt(right), 'descending') ||
    compareNullableInstants(left.updatedAt, right.updatedAt, 'descending') ||
    compareId(left, right)
  );
}

/**
 * Split merchant promotions using only the lifecycle state computed by the
 * API. Client time is deliberately not an input: the server remains the sole
 * authority for promotion lifecycle transitions.
 */
export function groupMerchantPromotions<T extends MerchantPromotionDto>(
  promotions: readonly T[]
): GroupedMerchantPromotions<T> {
  const groups: GroupedMerchantPromotions<T> = {
    active: [],
    scheduled: [],
    drafts: [],
    past: [],
  };

  for (const promotion of promotions) {
    switch (promotion.state) {
      case 'live':
        groups.active.push(promotion);
        break;
      case 'scheduled':
        groups.scheduled.push(promotion);
        break;
      case 'draft':
        groups.drafts.push(promotion);
        break;
      case 'ended':
      case 'cancelled':
        groups.past.push(promotion);
        break;
      default: {
        const unexpectedState: never = promotion.state;
        throw new RangeError(`Unsupported promotion state: ${String(unexpectedState)}`);
      }
    }
  }

  groups.active.sort(compareActive);
  groups.scheduled.sort(compareScheduled);
  groups.drafts.sort(compareDrafts);
  groups.past.sort(comparePast);
  return groups;
}

export type TodayHappyHourPresentationState = 'none' | 'upcoming' | 'live' | 'ended';

export interface TodayHappyHourPresentation {
  state: TodayHappyHourPresentationState;
  /** San Diego-local display range, for example `4:00 PM–6:00 PM`. */
  timeRange: string | null;
  statusText: string;
}

/**
 * Present today's recurring schedule against a server-anchored instant.
 * This function never labels recurring happy hour as a Live Deal.
 */
export function getTodayHappyHourPresentation(
  schedule: HappyHourSchedule | null | undefined,
  serverAnchoredNow: InstantInput
): TodayHappyHourPresentation {
  const now = parseInstant(serverAnchoredNow);
  if (!now) throw new RangeError('Expected serverAnchoredNow to be a valid absolute instant.');

  const occurrence = schedule
    ? getHappyHourOccurrenceForDate(schedule, getSanDiegoDateKey(now))
    : null;
  if (!occurrence) {
    return {
      state: 'none',
      timeRange: null,
      statusText: 'No regular happy hour today',
    };
  }

  const startText = formatSanDiegoTime(occurrence.startsAt);
  const endText = formatSanDiegoTime(occurrence.endsAt);
  const timeRange = `${startText}–${endText}`;
  const nowTime = now.getTime();

  if (nowTime < occurrence.startsAt.getTime()) {
    const countdown = formatCountdown(occurrence.startsAt, now);
    return {
      state: 'upcoming',
      timeRange,
      statusText: `Starts in ${countdown}`,
    };
  }

  if (nowTime < occurrence.endsAt.getTime()) {
    return {
      state: 'live',
      timeRange,
      statusText: `HAPPY HOUR NOW — ends at ${endText}`,
    };
  }

  return {
    state: 'ended',
    timeRange,
    statusText: "Today's regular happy hour has ended",
  };
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/** Format only the usage values supplied by the entitlement API. */
export function formatMerchantEntitlement(entitlement: MerchantPromotionEntitlementDto): string {
  const remaining = entitlement.remainingThisMonth;
  const unlimited = entitlement.isUnlimited || remaining === null;
  const summary = unlimited
    ? 'Unlimited promotions included this month'
    : remaining === 0
      ? 'No included promotions remaining this month'
      : `${remaining} included ${pluralize(remaining, 'promotion')} remaining this month`;

  if (entitlement.reserved === 0) return summary;
  return `${summary} · ${entitlement.reserved} scheduled ${pluralize(
    entitlement.reserved,
    'promotion'
  )} reserved`;
}

const PROMOTION_TYPE_LABELS: Readonly<Record<PromotionType, string>> = {
  special_deal: 'Special Deal',
  extended_happy_hour: 'Extended Happy Hour',
  event: 'Event',
  other: 'Other',
};

const PROMOTION_STATE_LABELS: Readonly<Record<PromotionState, string>> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  live: 'Live',
  ended: 'Ended',
  cancelled: 'Cancelled',
};

export function formatMerchantPromotionType(type: PromotionType): string {
  return PROMOTION_TYPE_LABELS[type];
}

export function formatMerchantPromotionState(state: PromotionState): string {
  return PROMOTION_STATE_LABELS[state];
}

export type MerchantLocalDateTimeDisambiguation = 'earlier' | 'later';

export type MerchantLocalDateTimeResolution =
  | { status: 'resolved'; instant: string }
  | { status: 'ambiguous'; earlier: string; later: string; error: string }
  | { status: 'nonexistent'; error: string }
  | { status: 'invalid'; error: string };

/**
 * Resolve an HTML datetime-local value as San Diego wall time. Ambiguous
 * fall-back times may be selected explicitly; spring-forward gaps remain an
 * actionable validation error.
 */
export function resolveMerchantLocalDateTime(
  value: string,
  disambiguation?: MerchantLocalDateTimeDisambiguation
): MerchantLocalDateTimeResolution {
  const resolution = resolveSanDiegoDateTimeLocal(value);
  switch (resolution.status) {
    case 'resolved':
      return { status: 'resolved', instant: resolution.instant.toISOString() };
    case 'ambiguous':
      if (disambiguation) {
        return {
          status: 'resolved',
          instant: resolution[disambiguation].toISOString(),
        };
      }
      return {
        status: 'ambiguous',
        earlier: resolution.earlier.toISOString(),
        later: resolution.later.toISOString(),
        error: 'That time occurs twice in San Diego. Choose the earlier or later occurrence.',
      };
    case 'nonexistent':
      return {
        status: 'nonexistent',
        error: 'That time does not exist in San Diego because the clocks move forward. Choose another time.',
      };
    case 'invalid':
      return {
        status: 'invalid',
        error: 'Enter a valid date and time.',
      };
  }
}
