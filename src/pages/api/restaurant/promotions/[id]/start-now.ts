import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../../lib/api';
import { merchantPromotionEnvelope, promotionServiceErrorResponse } from '../../../../../lib/promotionDtos';
import { startPromotionNow } from '../../../../../lib/promotionService';
import { getSession } from '../../../../../lib/session';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
    if (!body || Array.isArray(body)) throw new Error('Expected an object.');
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const unknown = Object.keys(body).filter((key) => key !== 'endsAt');
  if (unknown.length) return errorJson([`Immutable or unknown fields: ${unknown.join(', ')}.`], 400);
  try {
    const result = await startPromotionNow(session.userId, params.id || '', {
      ...(Object.hasOwn(body, 'endsAt') ? { endsAt: body.endsAt } : {}),
    });
    return json(merchantPromotionEnvelope(result.serverNow, result.promotion, result.entitlement));
  } catch (error) {
    const response = promotionServiceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};
