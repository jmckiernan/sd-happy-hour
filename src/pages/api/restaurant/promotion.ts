import type { APIRoute } from 'astro';
import { getRestaurantById, getPromotion, setPromotion, deletePromotion } from '../../../lib/store';
import { cleanString } from '../../../lib/validation';
import { getRestaurantSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// A restaurant reading back its own promotion always sees the code — the
// public gate in api/promotions.ts only applies to anonymous/consumer
// requests, not the restaurant that owns it.
export const GET: APIRoute = async ({ cookies }) => {
  const session = await getRestaurantSession(cookies);
  if (!session) return errorJson(['Restaurant login required.'], 401);

  const restaurant = await getRestaurantById(session.restaurantId);
  if (!restaurant || restaurant.venueId == null) return json({ promotion: null });

  const promotion = await getPromotion(restaurant.venueId);
  return json({ promotion });
};

// Sets (or clears) the promoted deal code for the signed-in restaurant's
// linked venue. The code itself is never exposed to anonymous visitors —
// see api/promotions.ts, which is the only thing that reads this store for
// public display and gates the code on being logged in.
export const PUT: APIRoute = async ({ request, cookies }) => {
  const session = await getRestaurantSession(cookies);
  if (!session) return errorJson(['Restaurant login required.'], 401);

  const restaurant = await getRestaurantById(session.restaurantId);
  if (!restaurant) return errorJson(['Restaurant not found.'], 404);
  if (!restaurant.verified) return errorJson(['Verify your account before promoting a deal.'], 403);
  if (restaurant.venueId == null) return errorJson(['Claim your listing before promoting a deal.'], 422);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const dealCode = cleanString(body.dealCode).slice(0, 30);
  const description = cleanString(body.description).slice(0, 200);
  if (!dealCode) return errorJson(['A deal code is required.'], 422);
  if (!description) return errorJson(['A short public description is required (e.g. "10% off your bill").'], 422);

  const promotion = await setPromotion(restaurant.venueId, { dealCode, description });
  return json(promotion);
};

export const DELETE: APIRoute = async ({ cookies }) => {
  const session = await getRestaurantSession(cookies);
  if (!session) return errorJson(['Restaurant login required.'], 401);

  const restaurant = await getRestaurantById(session.restaurantId);
  if (!restaurant) return errorJson(['Restaurant not found.'], 404);
  if (restaurant.venueId == null) return errorJson(['No linked venue.'], 422);

  await deletePromotion(restaurant.venueId);
  return json({ ok: true });
};
