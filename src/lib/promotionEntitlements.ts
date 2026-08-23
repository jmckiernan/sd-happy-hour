import { getEnv } from './env';
import type { PromotionStateInput } from './promotionState';
import { getSanDiegoMonthKey, parseInstant, type InstantInput } from './sanDiegoTime';

export const PROMOTION_PLANS = ['free', 'pro', 'founding_partner'] as const;
export type PromotionPlan = (typeof PROMOTION_PLANS)[number];

/** `null` is JSON-safe and means unlimited. */
export type PromotionAllowance = number | null;
export type PromotionAllowanceInput = PromotionAllowance | string | undefined;

export const PROMOTION_ALLOWANCE_ENV_VARS: Record<PromotionPlan, string> = {
  free: 'PROMOTION_FREE_MONTHLY_LIMIT',
  pro: 'PROMOTION_PRO_MONTHLY_LIMIT',
  founding_partner: 'PROMOTION_FOUNDING_PARTNER_MONTHLY_LIMIT',
};
export const PROMOTION_FOUNDING_PARTNER_VENUE_IDS_ENV = 'PROMOTION_FOUNDING_PARTNER_VENUE_IDS';

/**
 * Defaults are configuration defaults, not branching business logic. Every
 * plan still resolves through the same independently configurable lookup.
 */
export const DEFAULT_PROMOTION_ALLOWANCES: Readonly<Record<PromotionPlan, PromotionAllowance>> = {
  free: 1,
  pro: null,
  founding_partner: null,
};

export interface PromotionAllowanceConfiguration {
  /** Normalized/injected values take precedence over environment variables. */
  allowances?: Partial<Record<PromotionPlan, PromotionAllowanceInput>>;
  /** Supplying this object makes tests/callers independent of process env. */
  env?: Record<string, string | undefined>;
  /** Runtime founding-partner assignment, normally configured by venue id. */
  foundingPartnerVenueIds?: readonly number[] | string;
}

export interface PromotionPlanSource {
  plan?: unknown;
  venueId?: unknown;
}

export interface PromotionEntitlementInput extends PromotionAllowanceConfiguration {
  plan?: unknown;
  venueId?: unknown;
  usedThisMonth?: number;
  consumed?: number;
  reserved?: number;
  /** Venue-specific slots granted by an admin for this month. */
  additionalAllowance?: number;
  promotions?: readonly PromotionStateInput[];
  monthKey?: string;
  now?: InstantInput;
}

export interface PromotionEntitlement {
  plan: PromotionPlan;
  /** Included Live promotions per San Diego calendar month; null is unlimited. */
  allowance: PromotionAllowance;
  /** Plan allowance before venue-specific admin grants; null is unlimited. */
  baseAllowance: PromotionAllowance;
  /** Venue-specific slots granted by an admin for this month. */
  additionalAllowance: number;
  /** Descriptive alias for API/UI consumers. */
  monthlyAllowance: PromotionAllowance;
  monthKey: string;
  consumed: number;
  reserved: number;
  usedThisMonth: number;
  /** Remaining included promotions; null is unlimited. */
  remainingThisMonth: PromotionAllowance;
  /** Compatibility with the product copy's initial entitlement contract. */
  freePromotionsRemaining: PromotionAllowance;
  canLaunchPromotion: boolean;
  isUnlimited: boolean;
}

export interface MonthlyPromotionUsage {
  monthKey: string;
  consumed: number;
  reserved: number;
}

export interface MonthlyPromotionUsageOptions {
  now?: InstantInput;
  monthKey?: string;
}

function hasOwn(object: object | undefined, key: PropertyKey): boolean {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

/**
 * Parse one plan's allowance. Only a strictly positive safe integer or the
 * literal `unlimited` is accepted. A supplied invalid value throws instead of
 * silently granting a different quota.
 */
export function parsePromotionAllowance(
  value: PromotionAllowanceInput,
  fallback: PromotionAllowance,
  label = 'promotion allowance'
): PromotionAllowance {
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return fallback;
  if (value === null) return null;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'unlimited') return null;

  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new RangeError(`${label} must be a positive integer or "unlimited".`);
  }
  return numeric;
}

export function getPromotionAllowances(
  configuration: PromotionAllowanceConfiguration = {}
): Record<PromotionPlan, PromotionAllowance> {
  const result = {} as Record<PromotionPlan, PromotionAllowance>;
  for (const plan of PROMOTION_PLANS) {
    const envName = PROMOTION_ALLOWANCE_ENV_VARS[plan];
    let raw: PromotionAllowanceInput;
    if (hasOwn(configuration.allowances, plan)) {
      raw = configuration.allowances![plan];
    } else if (configuration.env !== undefined) {
      raw = configuration.env[envName];
    } else {
      raw = getEnv(envName);
    }
    result[plan] = parsePromotionAllowance(raw, DEFAULT_PROMOTION_ALLOWANCES[plan], envName);
  }
  return result;
}

export function parseFoundingPartnerVenueIds(value: readonly number[] | string | undefined): Set<number> {
  if (value === undefined || value === '') return new Set();
  const rawValues = Array.isArray(value) ? value : String(value).split(',').map((entry) => entry.trim());
  const venueIds = new Set<number>();
  for (const raw of rawValues) {
    const venueId = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^[1-9]\d*$/.test(raw)
        ? Number(raw)
        : Number.NaN;
    if (!Number.isSafeInteger(venueId) || venueId <= 0) {
      throw new RangeError(`${PROMOTION_FOUNDING_PARTNER_VENUE_IDS_ENV} must contain positive integer venue ids.`);
    }
    venueIds.add(venueId);
  }
  return venueIds;
}

function configuredFoundingPartnerVenueIds(configuration: PromotionAllowanceConfiguration): Set<number> {
  if (configuration.foundingPartnerVenueIds !== undefined) {
    return parseFoundingPartnerVenueIds(configuration.foundingPartnerVenueIds);
  }
  const raw = configuration.env !== undefined
    ? configuration.env[PROMOTION_FOUNDING_PARTNER_VENUE_IDS_ENV]
    : getEnv(PROMOTION_FOUNDING_PARTNER_VENUE_IDS_ENV);
  return parseFoundingPartnerVenueIds(raw);
}

/** Map legacy `paid` claims and configured founding-partner venues to plans. */
export function resolvePromotionPlan(
  source: unknown,
  configuration: PromotionAllowanceConfiguration = {}
): PromotionPlan {
  let raw = source;
  let venueId: unknown;
  if (source && typeof source === 'object') {
    const planSource = source as PromotionPlanSource;
    raw = planSource.plan;
    venueId = planSource.venueId;
  }

  const numericVenueId = typeof venueId === 'number'
    ? venueId
    : typeof venueId === 'string' && /^[1-9]\d*$/.test(venueId.trim())
      ? Number(venueId)
      : null;
  if (
    numericVenueId !== null &&
    Number.isSafeInteger(numericVenueId) &&
    configuredFoundingPartnerVenueIds(configuration).has(numericVenueId)
  ) {
    return 'founding_partner';
  }

  const plan = String(raw ?? '').trim().toLowerCase().replace(/[ -]+/g, '_');
  if (plan === 'founding' || plan === 'founding_partner') return 'founding_partner';
  if (plan === 'pro' || plan === 'paid') return 'pro';
  return 'free';
}

/**
 * Count one San Diego start-month's campaign usage. Publication reserves a
 * future slot; reaching the start instant consumes it permanently. Cancelling
 * before start releases the reservation, while ending or cancelling after
 * start never refunds consumed usage.
 */
export function getMonthlyPromotionUsage(
  promotions: readonly PromotionStateInput[],
  options: MonthlyPromotionUsageOptions = {}
): MonthlyPromotionUsage {
  const now = parseInstant(options.now ?? new Date());
  if (!now) throw new RangeError('Expected a valid absolute instant.');
  const monthKey = options.monthKey ?? getSanDiegoMonthKey(now);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new RangeError('monthKey must use YYYY-MM.');
  }

  let consumed = 0;
  let reserved = 0;
  for (const promotion of promotions) {
    const publishedAt = parseInstant(promotion.publishedAt);
    const startsAt = parseInstant(promotion.startsAt);
    if (!publishedAt || !startsAt || getSanDiegoMonthKey(startsAt) !== monthKey) continue;

    const cancelledAt = parseInstant(promotion.cancelledAt);
    if (cancelledAt && cancelledAt.getTime() < startsAt.getTime()) continue;

    if (startsAt.getTime() <= now.getTime()) consumed += 1;
    else reserved += 1;
  }
  return { monthKey, consumed, reserved };
}

function nonNegativeCount(value: number | undefined, label: string): number {
  const count = value ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`${label} must be a non-negative integer.`);
  }
  return count;
}

export function getPromotionEntitlement(
  input: PromotionEntitlementInput = {}
): PromotionEntitlement {
  const now = parseInstant(input.now ?? new Date());
  if (!now) throw new RangeError('Expected a valid absolute instant.');
  const computedUsage = input.promotions
    ? getMonthlyPromotionUsage(input.promotions, { now, monthKey: input.monthKey })
    : null;
  const monthKey = computedUsage?.monthKey ?? input.monthKey ?? getSanDiegoMonthKey(now);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) throw new RangeError('monthKey must use YYYY-MM.');

  const consumed = computedUsage?.consumed ?? nonNegativeCount(input.consumed ?? input.usedThisMonth, 'consumed');
  const reserved = computedUsage?.reserved ?? nonNegativeCount(input.reserved, 'reserved');
  const additionalAllowance = nonNegativeCount(input.additionalAllowance, 'additionalAllowance');
  const plan = resolvePromotionPlan(input, input);

  const baseAllowance = getPromotionAllowances(input)[plan];
  const allowance = baseAllowance === null ? null : baseAllowance + additionalAllowance;
  const remaining = allowance === null ? null : Math.max(allowance - consumed - reserved, 0);
  return {
    plan,
    allowance,
    baseAllowance,
    additionalAllowance,
    monthlyAllowance: allowance,
    monthKey,
    consumed,
    reserved,
    usedThisMonth: consumed,
    remainingThisMonth: remaining,
    freePromotionsRemaining: remaining,
    canLaunchPromotion: remaining === null || remaining > 0,
    isUnlimited: allowance === null,
  };
}
