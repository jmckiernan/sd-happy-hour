import { withTransaction, type QueryExecutor } from './db';
import { cancelPromotion, deletePromotionDraft, endPromotion, PromotionServiceError } from './promotionService';
import { getVerifiedPromotionClaim, getVerifiedPromotionClaimForShare } from './promotionAuthorization';
import {
  getDatabaseNow,
  getLegacyLinkedPromotionCampaign,
  getLegacyLinkedPromotionCampaignForUpdate,
  insertPromotionCampaign,
  listLegacyLinkedPromotionCampaigns,
  listLivePromotionCampaigns,
  lockPromotionVenue,
  replacePromotionCampaign,
  type PromotionCampaign,
} from './promotionRepo';
import { getPromotionState } from './promotionState';
import { cleanString, PROMOTION_DEAL_CODE_MAX_LENGTH, PROMOTION_DESCRIPTION_MAX_LENGTH } from './validation';
import { getVenueById } from './venues';

export interface LegacyPromotionDto {
  dealCode: string;
  description: string;
  updatedAt: string;
}

function forbidden(): PromotionServiceError {
  return new PromotionServiceError(
    403,
    'promotion_forbidden',
    ['You need a verified claim on this listing before promoting a deal.']
  );
}

function requireVenue(venueId: number): void {
  if (!Number.isSafeInteger(venueId) || venueId <= 0 || !getVenueById(venueId)) {
    throw new PromotionServiceError(404, 'venue_not_found', ['Venue not found.']);
  }
}

function toLegacyPromotion(promotion: PromotionCampaign): LegacyPromotionDto {
  return {
    dealCode: promotion.dealCode || '',
    description: promotion.description,
    updatedAt: promotion.updatedAt,
  };
}

async function requireClaim(
  userId: string,
  venueId: number,
  executor: QueryExecutor,
  lock = false
): Promise<void> {
  const claim = lock
    ? await getVerifiedPromotionClaimForShare(userId, venueId, executor)
    : await getVerifiedPromotionClaim(userId, venueId, executor);
  if (!claim) throw forbidden();
}

export async function getLegacyMerchantPromotion(
  userId: string,
  venueId: number
): Promise<LegacyPromotionDto | null> {
  if (!Number.isSafeInteger(venueId) || venueId <= 0) return null;
  const claim = await getVerifiedPromotionClaim(userId, venueId);
  if (!claim) return null;
  const promotion = await getLegacyLinkedPromotionCampaign(venueId);
  if (!promotion) return null;
  const state = getPromotionState(promotion, await getDatabaseNow());
  return state === 'ended' || state === 'cancelled' ? null : toLegacyPromotion(promotion);
}

export async function saveLegacyMerchantPromotion(
  userId: string,
  venueId: number,
  input: Record<string, unknown>
): Promise<LegacyPromotionDto> {
  requireVenue(venueId);
  const dealCode = cleanString(input.dealCode).slice(0, PROMOTION_DEAL_CODE_MAX_LENGTH);
  const description = cleanString(input.description).slice(0, PROMOTION_DESCRIPTION_MAX_LENGTH);
  const errors: string[] = [];
  if (!dealCode) errors.push('A deal code is required.');
  if (!description) errors.push('A short public description is required (e.g. "10% off your bill").');
  if (errors.length) throw new PromotionServiceError(422, 'validation_failed', errors);

  return withTransaction(async (tx) => {
    await lockPromotionVenue(tx, venueId);
    await requireClaim(userId, venueId, tx, true);
    const now = await getDatabaseNow(tx);
    const existing = await getLegacyLinkedPromotionCampaignForUpdate(venueId, tx);
    if (!existing) {
      return toLegacyPromotion(await insertPromotionCampaign(tx, {
        venueId,
        type: 'special_deal',
        title: null,
        description,
        dealCode,
        startsAt: null,
        endsAt: null,
        createdByUserId: userId,
        legacyPromotionVenueId: venueId,
      }));
    }
    const state = getPromotionState(existing, now);
    if (state !== 'draft') {
      throw new PromotionServiceError(
        409,
        'invalid_transition',
        [`A ${state} promotion cannot be edited through the legacy promotion form.`],
        { currentState: state }
      );
    }
    const updated = await replacePromotionCampaign(tx, existing.id, {
      type: existing.type,
      title: existing.title,
      description,
      dealCode,
      startsAt: existing.startsAt,
      endsAt: existing.endsAt,
      publishedAt: existing.publishedAt,
      endedAt: existing.endedAt,
      cancelledAt: existing.cancelledAt,
    });
    if (!updated) throw new PromotionServiceError(404, 'promotion_not_found', ['Promotion not found.']);
    return toLegacyPromotion(updated);
  });
}

export async function deleteLegacyMerchantPromotion(
  userId: string,
  venueId: number
): Promise<void> {
  requireVenue(venueId);
  const claim = await getVerifiedPromotionClaim(userId, venueId);
  if (!claim) throw forbidden();
  const promotion = await getLegacyLinkedPromotionCampaign(venueId);
  if (!promotion) return;
  const now = await getDatabaseNow();
  const state = getPromotionState(promotion, now);
  if (state === 'draft') await deletePromotionDraft(userId, promotion.id);
  else if (state === 'scheduled') await cancelPromotion(userId, promotion.id);
  else if (state === 'live') await endPromotion(userId, promotion.id);
  // Ended/cancelled campaign history is intentionally retained.
}

/**
 * Preserve the legacy venue-keyed shape without reading the old table.
 * Backfilled/editable legacy drafts remain visible, and a canonical live
 * campaign for a venue supersedes that baseline while it is active.
 */
export async function listLegacyPublicPromotions(
  serverNow: string
): Promise<Record<number, PromotionCampaign>> {
  const [legacy, live] = await Promise.all([
    listLegacyLinkedPromotionCampaigns(),
    listLivePromotionCampaigns(serverNow),
  ]);
  const result: Record<number, PromotionCampaign> = {};
  for (const promotion of legacy) {
    const state = getPromotionState(promotion, serverNow);
    // Only the unpublished draft imported from the old table is a legacy
    // baseline. Once published, it must obey canonical time-derived
    // visibility and can re-enter this map only through the live query.
    if (state === 'draft') result[promotion.venueId] = promotion;
  }
  for (const promotion of live) result[promotion.venueId] = promotion;
  return result;
}

export function legacyPublicPromotionDto(
  promotion: PromotionCampaign,
  includeDealCode: boolean
): { description: string; dealCode?: string } {
  // The legacy card has only one text slot. Preserve old draft copy, but
  // represent an active canonical Live Deal by its primary headline.
  const description = promotion.publishedAt && promotion.title
    ? promotion.title
    : promotion.description;
  return includeDealCode
    ? { description, dealCode: promotion.dealCode || '' }
    : { description };
}
