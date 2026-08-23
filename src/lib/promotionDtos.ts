import { json } from './api';
import type { PromotionEntitlement } from './promotionEntitlements';
import type { PromotionCampaign } from './promotionRepo';
import { getEffectivePromotionEnd, getPromotionState, type PromotionState } from './promotionState';
import { PromotionServiceError } from './promotionService';
import { getListingImage, slugify, type Venue } from './venues';

export interface PromotionActionsDto {
  update: boolean;
  publish: boolean;
  startNow: boolean;
  cancel: boolean;
  end: boolean;
  delete: boolean;
}

export interface MerchantPromotionDto {
  id: string;
  venueId: number;
  type: PromotionCampaign['type'];
  title: string | null;
  description: string;
  dealCode: string | null;
  startsAt: string | null;
  endsAt: string | null;
  effectiveEndsAt: string | null;
  state: PromotionState;
  publishedAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  allowedActions: PromotionActionsDto;
}

export interface PublicPromotionDto {
  id: string;
  venueId: number;
  venue: {
    id: number;
    name: string;
    slug: string;
    neighborhood: string;
    image: string;
    /** Untransformed featured image used if the card-sized CDN request fails. */
    imageOriginal?: string;
  };
  type: PromotionCampaign['type'];
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  effectiveEndsAt: string;
  state: 'live';
  hasDealCode: boolean;
  dealCode?: string | null;
}

function allowedActions(state: PromotionState): PromotionActionsDto {
  return {
    update: state === 'draft' || state === 'scheduled',
    publish: state === 'draft',
    startNow: state === 'draft' || state === 'scheduled',
    cancel: state === 'scheduled',
    end: state === 'live',
    delete: state === 'draft',
  };
}

export function toMerchantPromotionDto(
  promotion: PromotionCampaign,
  serverNow: string
): MerchantPromotionDto {
  const state = getPromotionState(promotion, serverNow);
  return {
    id: promotion.id,
    venueId: promotion.venueId,
    type: promotion.type,
    title: promotion.title,
    description: promotion.description,
    dealCode: promotion.dealCode,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    effectiveEndsAt: getEffectivePromotionEnd(promotion)?.toISOString() ?? null,
    state,
    publishedAt: promotion.publishedAt,
    endedAt: promotion.endedAt,
    cancelledAt: promotion.cancelledAt,
    createdAt: promotion.createdAt,
    updatedAt: promotion.updatedAt,
    allowedActions: allowedActions(state),
  };
}

export function toPublicPromotionDto(
  promotion: PromotionCampaign,
  venue: Venue,
  serverNow: string,
  includeDealCode: boolean
): PublicPromotionDto {
  const state = getPromotionState(promotion, serverNow);
  if (
    state !== 'live' ||
    !promotion.title ||
    !promotion.startsAt ||
    !promotion.endsAt
  ) {
    throw new RangeError('Public promotion DTOs require a complete live promotion.');
  }
  const effectiveEndsAt = getEffectivePromotionEnd(promotion)?.toISOString();
  if (!effectiveEndsAt) throw new RangeError('A live promotion requires an effective end.');

  const result: PublicPromotionDto = {
    id: promotion.id,
    venueId: promotion.venueId,
    venue: {
      id: venue.id,
      name: venue.name,
      slug: slugify(venue.name),
      neighborhood: venue.neighborhood,
      image: getListingImage(venue, 'card'),
      imageOriginal: venue.image || '',
    },
    type: promotion.type,
    title: promotion.title,
    description: promotion.description,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    effectiveEndsAt,
    state: 'live',
    hasDealCode: Boolean(promotion.dealCode),
  };
  if (includeDealCode) result.dealCode = promotion.dealCode;
  return result;
}

export function merchantPromotionEnvelope(
  serverNow: string,
  promotion: PromotionCampaign,
  entitlement: PromotionEntitlement
) {
  return {
    serverNow,
    promotion: toMerchantPromotionDto(promotion, serverNow),
    entitlement,
  };
}

export function promotionServiceErrorResponse(error: unknown): Response | null {
  if (!(error instanceof PromotionServiceError)) return null;
  return json(
    {
      code: error.code,
      errors: error.errors,
      ...(error.details ? { details: error.details } : {}),
    },
    error.status
  );
}

/** Public promotion payloads vary by the session cookie and are never cacheable. */
export function authenticationSensitivePromotionJson(body: unknown, status = 200): Response {
  const response = json(body, status);
  response.headers.set('cache-control', 'private, no-store');
  response.headers.set('vary', 'Cookie');
  return response;
}
