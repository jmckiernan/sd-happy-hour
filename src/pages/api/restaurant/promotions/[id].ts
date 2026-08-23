import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import {
  merchantPromotionEnvelope,
  promotionServiceErrorResponse,
} from '../../../../lib/promotionDtos';
import {
  deletePromotionDraft,
  getMerchantPromotion,
  updatePromotion,
} from '../../../../lib/promotionService';
import { getSession } from '../../../../lib/session';

export const prerender = false;

const PATCH_FIELDS = new Set(['type', 'title', 'description', 'dealCode', 'imageKey', 'startsAt', 'endsAt']);

export const GET: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);
  try {
    const result = await getMerchantPromotion(session.userId, params.id || '');
    return json(merchantPromotionEnvelope(result.serverNow, result.promotion, result.entitlement));
  } catch (error) {
    const response = promotionServiceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
    if (!body || Array.isArray(body)) throw new Error('Expected an object.');
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const unknown = Object.keys(body).filter((key) => !PATCH_FIELDS.has(key));
  if (unknown.length) {
    return errorJson([
      `Immutable or unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`,
    ], 400);
  }
  if (!Object.keys(body).length) return errorJson(['At least one editable field is required.'], 400);

  try {
    const result = await updatePromotion(session.userId, params.id || '', body);
    return json(merchantPromotionEnvelope(result.serverNow, result.promotion, result.entitlement));
  } catch (error) {
    const response = promotionServiceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);
  try {
    const result = await deletePromotionDraft(session.userId, params.id || '');
    return json(result);
  } catch (error) {
    const response = promotionServiceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};
