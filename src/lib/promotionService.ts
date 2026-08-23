import { sql, withTransaction, type QueryExecutor } from './db';
import {
  getVerifiedPromotionClaim,
  getVerifiedPromotionClaimForShare,
  type VerifiedPromotionClaim,
} from './promotionAuthorization';
import {
  deleteUnpublishedPromotionCampaign,
  getDatabaseNow,
  getPromotionCampaignById,
  getPromotionCampaignByIdForUpdate,
  insertPromotionCampaign,
  listPromotionCampaignsByVenue,
  lockPromotionVenue,
  replacePromotionCampaign,
  type PromotionCampaign,
  type ReplacePromotionCampaignInput,
} from './promotionRepo';
import {
  cancelPromotionStartedEvent,
  expirePromotionStartedEvent,
  upsertPromotionStartedEvent,
} from './notificationEventRepo';
import {
  findPromotionWindowConflict,
  getPromotionState,
  type PromotionState,
} from './promotionState';
import {
  getPromotionEntitlement,
  type PromotionEntitlement,
} from './promotionEntitlements';
import { getSanDiegoMonthKey, parseInstant } from './sanDiegoTime';
import { getAdditionalPromotionAllowance } from './promotionAllowanceRepo';
import { validatePromotionInput, type CleanPromotionInput } from './validation';
import { getVenueById } from './venues';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PromotionServiceErrorCode =
  | 'invalid_request'
  | 'validation_failed'
  | 'venue_not_found'
  | 'promotion_not_found'
  | 'promotion_forbidden'
  | 'invalid_transition'
  | 'promotion_overlap'
  | 'promotion_quota_exhausted';

export class PromotionServiceError extends Error {
  status: number;
  code: PromotionServiceErrorCode;
  errors: string[];
  details?: Record<string, unknown>;

  constructor(
    status: number,
    code: PromotionServiceErrorCode,
    errors: string[],
    details?: Record<string, unknown>
  ) {
    super(errors.join(' '));
    this.name = 'PromotionServiceError';
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.details = details;
  }
}

export interface PromotionWriteInput {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  dealCode?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
}

export interface CreatePromotionDraftInput extends PromotionWriteInput {
  venueId: number;
}

export interface PromotionMutationResult {
  serverNow: string;
  promotion: PromotionCampaign;
  entitlement: PromotionEntitlement;
}

export interface PromotionListResult {
  serverNow: string;
  venueId: number;
  promotions: PromotionCampaign[];
  entitlement: PromotionEntitlement;
}

export interface PromotionDeleteResult {
  serverNow: string;
  deletedId: string;
  entitlement: PromotionEntitlement;
}

interface MutationContext {
  tx: QueryExecutor;
  now: string;
  claim: VerifiedPromotionClaim;
  promotion: PromotionCampaign;
}

function serviceError(
  status: number,
  code: PromotionServiceErrorCode,
  message: string,
  details?: Record<string, unknown>
): PromotionServiceError {
  return new PromotionServiceError(status, code, [message], details);
}

function validateVenueId(venueId: number): void {
  if (!Number.isSafeInteger(venueId) || venueId <= 0) {
    throw serviceError(400, 'invalid_request', 'Invalid venue id.');
  }
}

function requireVenue(venueId: number): void {
  validateVenueId(venueId);
  if (!getVenueById(venueId)) {
    throw serviceError(404, 'venue_not_found', 'Venue not found.');
  }
}

function validatePromotionId(id: string): void {
  if (!UUID.test(String(id || ''))) {
    throw serviceError(400, 'invalid_request', 'Invalid promotion id.');
  }
}

function hasOwn(input: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function rawMergedInput(
  promotion: PromotionCampaign,
  patch: PromotionWriteInput,
  forced: PromotionWriteInput = {}
): Record<string, unknown> {
  const value = (key: keyof PromotionWriteInput, current: unknown): unknown => {
    if (hasOwn(forced, key)) return forced[key];
    return hasOwn(patch, key) ? patch[key] : current;
  };
  return {
    type: value('type', promotion.type),
    title: value('title', promotion.title),
    description: value('description', promotion.description),
    dealCode: value('dealCode', promotion.dealCode),
    startsAt: value('startsAt', promotion.startsAt),
    endsAt: value('endsAt', promotion.endsAt),
  };
}

function validateInput(
  input: Record<string, unknown>,
  mode: 'draft' | 'publish'
): CleanPromotionInput {
  const result = validatePromotionInput(input, { mode });
  if (result.errors.length) {
    throw new PromotionServiceError(422, 'validation_failed', result.errors);
  }
  return result.promotion;
}

function replacement(
  promotion: PromotionCampaign,
  clean: CleanPromotionInput,
  lifecycle: Partial<Pick<ReplacePromotionCampaignInput, 'publishedAt' | 'endedAt' | 'cancelledAt'>> = {}
): ReplacePromotionCampaignInput {
  return {
    type: clean.type,
    title: clean.title || null,
    description: clean.description,
    dealCode: clean.dealCode,
    startsAt: clean.startsAt,
    endsAt: clean.endsAt,
    publishedAt: lifecycle.publishedAt === undefined ? promotion.publishedAt : lifecycle.publishedAt,
    endedAt: lifecycle.endedAt === undefined ? promotion.endedAt : lifecycle.endedAt,
    cancelledAt: lifecycle.cancelledAt === undefined ? promotion.cancelledAt : lifecycle.cancelledAt,
  };
}

function stateError(state: PromotionState, action: string): PromotionServiceError {
  return serviceError(
    409,
    'invalid_transition',
    `A ${state} promotion cannot ${action}.`,
    { currentState: state }
  );
}

async function requireClaim(
  tx: QueryExecutor,
  userId: string,
  venueId: number
): Promise<VerifiedPromotionClaim> {
  const claim = await getVerifiedPromotionClaimForShare(userId, venueId, tx);
  if (!claim) {
    throw serviceError(
      403,
      'promotion_forbidden',
      'You need a verified claim on this listing to manage its promotions.'
    );
  }
  return claim;
}

async function entitlementFor(
  tx: QueryExecutor,
  claim: VerifiedPromotionClaim,
  venueId: number,
  promotions: PromotionCampaign[],
  now: string,
  monthKey?: string
): Promise<PromotionEntitlement> {
  const targetMonth = monthKey ?? getSanDiegoMonthKey(parseInstant(now)!);
  const additionalAllowance = await getAdditionalPromotionAllowance(venueId, targetMonth, tx);
  return getPromotionEntitlement({
    plan: claim.plan,
    venueId,
    promotions,
    now,
    monthKey: targetMonth,
    additionalAllowance,
  });
}

async function currentEntitlement(
  tx: QueryExecutor,
  claim: VerifiedPromotionClaim,
  venueId: number,
  now: string
): Promise<PromotionEntitlement> {
  return entitlementFor(
    tx,
    claim,
    venueId,
    await listPromotionCampaignsByVenue(venueId, tx),
    now
  );
}

function requireFutureStart(clean: CleanPromotionInput, now: string): void {
  const startsAt = parseInstant(clean.startsAt);
  const instant = parseInstant(now)!;
  if (!startsAt || startsAt.getTime() <= instant.getTime()) {
    throw serviceError(
      422,
      'validation_failed',
      'A scheduled promotion must start in the future. Use Start Now to launch immediately.'
    );
  }
}

function assertNoOverlap(candidate: PromotionCampaign, existing: PromotionCampaign[]): void {
  const conflict = findPromotionWindowConflict(candidate, existing);
  if (!conflict) return;
  throw serviceError(
    409,
    'promotion_overlap',
    'This venue already has a published promotion in that time window.',
    {
      conflict: {
        promotionId: conflict.id,
        startsAt: conflict.startsAt,
        endsAt: conflict.endsAt,
      },
    }
  );
}

async function assertQuotaSlot(
  tx: QueryExecutor,
  claim: VerifiedPromotionClaim,
  candidate: PromotionCampaign,
  existing: PromotionCampaign[],
  now: string
): Promise<void> {
  const startsAt = parseInstant(candidate.startsAt);
  if (!startsAt) {
    throw serviceError(422, 'validation_failed', 'Promotion start is required before publishing.');
  }
  const monthKey = getSanDiegoMonthKey(startsAt);
  const withoutCandidate = existing.filter((promotion) => promotion.id !== candidate.id);
  const entitlement = await entitlementFor(tx, claim, candidate.venueId, withoutCandidate, now, monthKey);
  if (entitlement.canLaunchPromotion) return;
  throw serviceError(
    409,
    'promotion_quota_exhausted',
    `No included promotion is available for ${monthKey}.`,
    { entitlement }
  );
}

async function withExistingPromotionMutation<T>(
  userId: string,
  promotionId: string,
  requireCatalogVenue: boolean,
  run: (context: MutationContext) => Promise<T>
): Promise<T> {
  validatePromotionId(promotionId);
  const initial = await getPromotionCampaignById(promotionId);
  if (!initial) throw serviceError(404, 'promotion_not_found', 'Promotion not found.');
  if (requireCatalogVenue) requireVenue(initial.venueId);

  return withTransaction(async (tx) => {
    await lockPromotionVenue(tx, initial.venueId);
    const promotion = await getPromotionCampaignByIdForUpdate(promotionId, tx);
    if (!promotion || promotion.venueId !== initial.venueId) {
      throw serviceError(404, 'promotion_not_found', 'Promotion not found.');
    }
    const claim = await requireClaim(tx, userId, promotion.venueId);
    const now = await getDatabaseNow(tx);
    return run({ tx, now, claim, promotion });
  });
}

async function persistedMutationResult(
  context: MutationContext,
  promotion: PromotionCampaign
): Promise<PromotionMutationResult> {
  return {
    serverNow: context.now,
    promotion,
    entitlement: await currentEntitlement(
      context.tx,
      context.claim,
      promotion.venueId,
      context.now
    ),
  };
}

export async function listMerchantPromotions(
  userId: string,
  venueId: number
): Promise<PromotionListResult> {
  requireVenue(venueId);
  return withTransaction(async (tx) => {
    const claim = await getVerifiedPromotionClaim(userId, venueId, tx);
    if (!claim) {
      throw serviceError(
        403,
        'promotion_forbidden',
        'You need a verified claim on this listing to view its promotions.'
      );
    }
    const now = await getDatabaseNow(tx);
    const promotions = await listPromotionCampaignsByVenue(venueId, tx);
    return {
      serverNow: now,
      venueId,
      promotions,
      entitlement: await entitlementFor(tx, claim, venueId, promotions, now),
    };
  });
}

export async function getMerchantPromotion(
  userId: string,
  promotionId: string
): Promise<PromotionMutationResult> {
  validatePromotionId(promotionId);
  const promotion = await getPromotionCampaignById(promotionId);
  if (!promotion) throw serviceError(404, 'promotion_not_found', 'Promotion not found.');
  const claim = await getVerifiedPromotionClaim(userId, promotion.venueId);
  if (!claim) {
    throw serviceError(
      403,
      'promotion_forbidden',
      'You need a verified claim on this listing to view its promotions.'
    );
  }
  const now = await getDatabaseNow();
  const promotions = await listPromotionCampaignsByVenue(promotion.venueId);
  return {
    serverNow: now,
    promotion,
    entitlement: await entitlementFor(sql, claim, promotion.venueId, promotions, now),
  };
}

export async function createPromotionDraft(
  userId: string,
  input: CreatePromotionDraftInput
): Promise<PromotionMutationResult> {
  requireVenue(input.venueId);
  const clean = validateInput(
    {
      type: input.type,
      title: input.title,
      description: input.description,
      dealCode: input.dealCode,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    },
    'draft'
  );

  return withTransaction(async (tx) => {
    await lockPromotionVenue(tx, input.venueId);
    const claim = await requireClaim(tx, userId, input.venueId);
    const now = await getDatabaseNow(tx);
    const promotion = await insertPromotionCampaign(tx, {
      venueId: input.venueId,
      type: clean.type,
      title: clean.title || null,
      description: clean.description,
      dealCode: clean.dealCode,
      startsAt: clean.startsAt,
      endsAt: clean.endsAt,
      createdByUserId: userId,
    });
    return {
      serverNow: now,
      promotion,
      entitlement: await currentEntitlement(tx, claim, input.venueId, now),
    };
  });
}

export async function updatePromotion(
  userId: string,
  promotionId: string,
  patch: PromotionWriteInput
): Promise<PromotionMutationResult> {
  return withExistingPromotionMutation(userId, promotionId, true, async (context) => {
    const state = getPromotionState(context.promotion, context.now);
    if (state !== 'draft' && state !== 'scheduled') throw stateError(state, 'be updated');

    const clean = validateInput(
      rawMergedInput(context.promotion, patch),
      state === 'scheduled' ? 'publish' : 'draft'
    );
    if (state === 'scheduled') requireFutureStart(clean, context.now);

    const proposed: PromotionCampaign = {
      ...context.promotion,
      ...replacement(context.promotion, clean),
    };
    const existing = await listPromotionCampaignsByVenue(proposed.venueId, context.tx);

    if (state === 'scheduled') {
      assertNoOverlap(proposed, existing);
      const oldMonth = getSanDiegoMonthKey(parseInstant(context.promotion.startsAt)!);
      const newMonth = getSanDiegoMonthKey(parseInstant(proposed.startsAt)!);
      if (oldMonth !== newMonth) {
        await assertQuotaSlot(context.tx, context.claim, proposed, existing, context.now);
      }
    }

    const updated = await replacePromotionCampaign(
      context.tx,
      proposed.id,
      replacement(context.promotion, clean)
    );
    if (!updated) throw serviceError(404, 'promotion_not_found', 'Promotion not found.');
    if (state === 'scheduled') await upsertPromotionStartedEvent(context.tx, updated);
    return persistedMutationResult(context, updated);
  });
}

export async function deletePromotionDraft(
  userId: string,
  promotionId: string
): Promise<PromotionDeleteResult> {
  return withExistingPromotionMutation(userId, promotionId, true, async (context) => {
    const state = getPromotionState(context.promotion, context.now);
    if (state !== 'draft') throw stateError(state, 'be deleted');
    const deleted = await deleteUnpublishedPromotionCampaign(context.tx, context.promotion.id);
    if (!deleted) throw serviceError(409, 'invalid_transition', 'Published promotions cannot be deleted.');
    return {
      serverNow: context.now,
      deletedId: context.promotion.id,
      entitlement: await currentEntitlement(
        context.tx,
        context.claim,
        context.promotion.venueId,
        context.now
      ),
    };
  });
}

export async function publishPromotion(
  userId: string,
  promotionId: string,
  timing: Pick<PromotionWriteInput, 'startsAt' | 'endsAt'> = {}
): Promise<PromotionMutationResult> {
  return withExistingPromotionMutation(userId, promotionId, true, async (context) => {
    const state = getPromotionState(context.promotion, context.now);
    if (state !== 'draft') throw stateError(state, 'be published');
    const clean = validateInput(rawMergedInput(context.promotion, timing), 'publish');
    requireFutureStart(clean, context.now);

    const proposed: PromotionCampaign = {
      ...context.promotion,
      ...replacement(context.promotion, clean, { publishedAt: context.now }),
    };
    const existing = await listPromotionCampaignsByVenue(proposed.venueId, context.tx);
    assertNoOverlap(proposed, existing);
    await assertQuotaSlot(context.tx, context.claim, proposed, existing, context.now);

    const updated = await replacePromotionCampaign(
      context.tx,
      proposed.id,
      replacement(context.promotion, clean, { publishedAt: context.now })
    );
    if (!updated) throw serviceError(404, 'promotion_not_found', 'Promotion not found.');
    await upsertPromotionStartedEvent(context.tx, updated);
    return persistedMutationResult(context, updated);
  });
}

export async function startPromotionNow(
  userId: string,
  promotionId: string,
  input: Pick<PromotionWriteInput, 'endsAt'> = {}
): Promise<PromotionMutationResult> {
  return withExistingPromotionMutation(userId, promotionId, true, async (context) => {
    const state = getPromotionState(context.promotion, context.now);
    if (state !== 'draft' && state !== 'scheduled') throw stateError(state, 'start now');
    const clean = validateInput(
      rawMergedInput(context.promotion, input, { startsAt: context.now }),
      'publish'
    );

    const proposed: PromotionCampaign = {
      ...context.promotion,
      ...replacement(context.promotion, clean, {
        publishedAt: context.promotion.publishedAt || context.now,
      }),
    };
    const existing = await listPromotionCampaignsByVenue(proposed.venueId, context.tx);
    assertNoOverlap(proposed, existing);

    const oldMonth = context.promotion.startsAt
      ? getSanDiegoMonthKey(parseInstant(context.promotion.startsAt)!)
      : null;
    const newMonth = getSanDiegoMonthKey(parseInstant(proposed.startsAt)!);
    if (state === 'draft' || oldMonth !== newMonth) {
      await assertQuotaSlot(context.tx, context.claim, proposed, existing, context.now);
    }

    const updated = await replacePromotionCampaign(
      context.tx,
      proposed.id,
      replacement(context.promotion, clean, {
        publishedAt: context.promotion.publishedAt || context.now,
      })
    );
    if (!updated) throw serviceError(404, 'promotion_not_found', 'Promotion not found.');
    await upsertPromotionStartedEvent(context.tx, updated);
    return persistedMutationResult(context, updated);
  });
}

export async function cancelPromotion(
  userId: string,
  promotionId: string
): Promise<PromotionMutationResult> {
  return withExistingPromotionMutation(userId, promotionId, false, async (context) => {
    const state = getPromotionState(context.promotion, context.now);
    if (state !== 'scheduled') throw stateError(state, 'be cancelled');
    const updated = await replacePromotionCampaign(context.tx, context.promotion.id, {
      type: context.promotion.type,
      title: context.promotion.title,
      description: context.promotion.description,
      dealCode: context.promotion.dealCode,
      startsAt: context.promotion.startsAt,
      endsAt: context.promotion.endsAt,
      publishedAt: context.promotion.publishedAt,
      endedAt: null,
      cancelledAt: context.now,
    });
    if (!updated) throw serviceError(404, 'promotion_not_found', 'Promotion not found.');
    await cancelPromotionStartedEvent(context.tx, updated.id, context.now);
    return persistedMutationResult(context, updated);
  });
}

export async function endPromotion(
  userId: string,
  promotionId: string
): Promise<PromotionMutationResult> {
  return withExistingPromotionMutation(userId, promotionId, false, async (context) => {
    const state = getPromotionState(context.promotion, context.now);
    if (state !== 'live') throw stateError(state, 'be ended');
    const updated = await replacePromotionCampaign(context.tx, context.promotion.id, {
      type: context.promotion.type,
      title: context.promotion.title,
      description: context.promotion.description,
      dealCode: context.promotion.dealCode,
      startsAt: context.promotion.startsAt,
      endsAt: context.promotion.endsAt,
      publishedAt: context.promotion.publishedAt,
      endedAt: context.now,
      cancelledAt: null,
    });
    if (!updated) throw serviceError(404, 'promotion_not_found', 'Promotion not found.');
    await expirePromotionStartedEvent(context.tx, updated.id, context.now);
    return persistedMutationResult(context, updated);
  });
}
