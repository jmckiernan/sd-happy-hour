import type { APIRoute } from 'astro';
import {
  deleteLegacyMerchantPromotion,
  getLegacyMerchantPromotion,
  saveLegacyMerchantPromotion,
} from '../../../lib/legacyPromotionAdapter';
import { promotionServiceErrorResponse } from '../../../lib/promotionDtos';
import { getSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// venueId now comes from the query string / body instead of being implied
// by a single-restaurant session, since a user can hold claims on more than
// one venue (see the 2026-08-12 redesign). Every request re-checks that the
// signed-in user holds a *verified* claim on that specific venue — a
// restaurant reading back its own promotion always sees the code; the
// public gate in api/promotions.ts only applies to anonymous/consumer
// requests.
export const GET: APIRoute = async ({ url, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  const venueId = Number(url.searchParams.get('venueId'));
  const promotion = await getLegacyMerchantPromotion(session.userId, venueId);
  return json({ promotion });
};

export const PUT: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  try {
    const promotion = await saveLegacyMerchantPromotion(
      session.userId,
      Number(body.venueId),
      body
    );
    return json(promotion);
  } catch (error) {
    const response = promotionServiceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    body = {};
  }

  try {
    await deleteLegacyMerchantPromotion(session.userId, Number(body.venueId));
    return json({ ok: true });
  } catch (error) {
    const response = promotionServiceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};
