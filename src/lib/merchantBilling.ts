import type { QueryExecutor } from './db';
import { sql } from './db';
import {
  getMerchantEntitlement,
  type MerchantEntitlement,
  type MerchantEntitlementSource,
} from './merchantEntitlements';
import { getVerifiedPromotionClaimByVenue } from './promotionAuthorization';
import { getAdditionalPromotionAllowance } from './promotionAllowanceRepo';
import {
  getPromotionEntitlement,
  resolvePromotionPlan,
  type PromotionEntitlement,
  type PromotionPlan,
} from './promotionEntitlements';
import {
  getDatabaseNow,
  listPromotionCampaignsByVenue,
} from './promotionRepo';
import { getSanDiegoMonthKey } from './sanDiegoTime';
import { getVenueById, venueSlug } from './venues';

export const PROMOTION_PLAN_LABELS: Readonly<Record<PromotionPlan, string>> = {
  free: 'Free',
  pro: 'Pro',
  founding_partner: 'Founding Partner',
};

export function formatPromotionPlanLabel(plan: PromotionPlan): string {
  return PROMOTION_PLAN_LABELS[plan];
}

export interface MerchantBillingPlan {
  id: PromotionPlan;
  label: string;
  /** Raw verified claim plan (`free` / `paid`); null if no verified claim. */
  claimPlan: 'free' | 'paid' | null;
}

export interface MerchantBillingInvoice {
  id: string;
  amountCents: number;
  amountDisplay: string;
  status: string;
  billedAt: string | null;
  description: string;
}

export interface MerchantBillingSpend {
  amountCents: number;
  amountDisplay: string;
  currency: 'USD';
  periodMonthKey: string;
  message: string;
  invoices: MerchantBillingInvoice[];
}

export interface MerchantBillingPromotionalCredits {
  monthKey: string;
  additionalAllowance: number;
}

export interface MerchantBillingReportingAccess {
  active: boolean;
  source: MerchantEntitlementSource | null;
  accessStartsAt: string | null;
  accessEndsAt: string | null;
}

export interface MerchantBillingActions {
  /** Owner-only redeem path already exists at `/api/restaurant/reports/redeem`. */
  canRedeemAccessCode: boolean;
  /** Soft upgrade CTA only; Stripe Checkout is not wired. */
  contactUpgradeAvailable: boolean;
}

export interface MerchantBillingSummary {
  venueId: number;
  venueName: string;
  venueSlug: string;
  neighborhood: string;
  serverNow: string;
  plan: MerchantBillingPlan;
  spend: MerchantBillingSpend;
  promotionEntitlement: PromotionEntitlement;
  promotionalCredits: MerchantBillingPromotionalCredits;
  reportingAccess: MerchantBillingReportingAccess;
  actions: MerchantBillingActions;
}

function mapReportingAccess(entitlement: MerchantEntitlement | null): MerchantBillingReportingAccess {
  if (!entitlement) {
    return {
      active: false,
      source: null,
      accessStartsAt: null,
      accessEndsAt: null,
    };
  }
  return {
    active: entitlement.active,
    source: entitlement.source,
    accessStartsAt: entitlement.accessStartsAt,
    accessEndsAt: entitlement.accessEndsAt,
  };
}

/**
 * Aggregates plan, promotion quota, admin credits, and reporting entitlement
 * for the Billing workspace. Spend/invoices stay empty until Stripe exists.
 */
export async function getMerchantBillingSummary(
  venueId: number,
  options: { role?: string | null } = {},
  executor: QueryExecutor = sql
): Promise<MerchantBillingSummary | null> {
  const venue = getVenueById(venueId);
  if (!venue) return null;

  const serverNow = await getDatabaseNow(executor);
  const monthKey = getSanDiegoMonthKey(serverNow);
  const [claim, promotions, additionalAllowance, reporting] = await Promise.all([
    getVerifiedPromotionClaimByVenue(venueId, executor),
    listPromotionCampaignsByVenue(venueId, executor),
    getAdditionalPromotionAllowance(venueId, monthKey, executor),
    getMerchantEntitlement(venueId, executor),
  ]);

  const planId = resolvePromotionPlan({ plan: claim?.plan ?? 'free', venueId });
  const promotionEntitlement = getPromotionEntitlement({
    plan: claim?.plan ?? 'free',
    venueId,
    promotions,
    now: serverNow,
    monthKey,
    additionalAllowance,
  });

  const role = options.role ?? null;
  return {
    venueId: venue.id,
    venueName: venue.name,
    venueSlug: venueSlug(venue),
    neighborhood: venue.neighborhood,
    serverNow,
    plan: {
      id: planId,
      label: formatPromotionPlanLabel(planId),
      claimPlan: claim?.plan ?? null,
    },
    spend: {
      amountCents: 0,
      amountDisplay: '$0.00',
      currency: 'USD',
      periodMonthKey: monthKey,
      message: 'No charges this period',
      invoices: [],
    },
    promotionEntitlement,
    promotionalCredits: {
      monthKey,
      additionalAllowance,
    },
    reportingAccess: mapReportingAccess(reporting),
    actions: {
      canRedeemAccessCode: role === 'owner',
      contactUpgradeAvailable: true,
    },
  };
}
