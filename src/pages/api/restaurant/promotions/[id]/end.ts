import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../../lib/api';
import { merchantPromotionEnvelope, promotionServiceErrorResponse } from '../../../../../lib/promotionDtos';
import { endPromotion } from '../../../../../lib/promotionService';
import { getSession } from '../../../../../lib/session';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);
  try {
    const body = await readJsonBody(request);
    if (!body || Array.isArray(body) || Object.keys(body).length) {
      return errorJson(['End does not accept request fields.'], 400);
    }
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  try {
    const result = await endPromotion(session.userId, params.id || '');
    return json(merchantPromotionEnvelope(result.serverNow, result.promotion, result.entitlement));
  } catch (error) {
    const response = promotionServiceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};
