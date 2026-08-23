import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import {
  merchantPromotionEnvelope,
  promotionServiceErrorResponse,
  toMerchantPromotionDto,
} from '../../../../lib/promotionDtos';
import { createPromotionDraft, listMerchantPromotions } from '../../../../lib/promotionService';
import { getSession } from '../../../../lib/session';

export const prerender = false;

const CREATE_FIELDS = new Set([
  'venueId',
  'type',
  'title',
  'description',
  'dealCode',
  'imageKey',
  'startsAt',
  'endsAt',
]);

function unknownFields(body: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(body).filter((key) => !allowed.has(key));
}

export const GET: APIRoute = async ({ url, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  const venueId = Number(url.searchParams.get('venueId'));
  try {
    const result = await listMerchantPromotions(session.userId, venueId);
    return json({
      serverNow: result.serverNow,
      venueId: result.venueId,
      promotions: result.promotions.map((promotion) =>
        toMerchantPromotionDto(promotion, result.serverNow)
      ),
      entitlement: result.entitlement,
    });
  } catch (error) {
    const response = promotionServiceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
    if (!body || Array.isArray(body)) throw new Error('Expected an object.');
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const unknown = unknownFields(body, CREATE_FIELDS);
  if (unknown.length) return errorJson([`Unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`], 400);

  try {
    const result = await createPromotionDraft(session.userId, {
      venueId: Number(body.venueId),
      type: body.type,
      title: body.title,
      description: body.description,
      dealCode: body.dealCode,
      imageKey: body.imageKey,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
    });
    return json(
      merchantPromotionEnvelope(result.serverNow, result.promotion, result.entitlement),
      201
    );
  } catch (error) {
    const response = promotionServiceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};
