import type { APIRoute } from 'astro';
import { readRestaurants, writeRestaurants, publicRestaurant, cleanString } from '../../../../lib/kv';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../../lib/api';

export const prerender = false;

// Approve or deny a manual-claim restaurant verification (domain-matched
// restaurants never reach this — they're auto-verified at signup). See the
// alerts spec, "Restaurant Verification".
export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  const restaurants = await readRestaurants();
  const restaurant = restaurants.find((item) => item.id === params.id);
  if (!restaurant) return errorJson(['Restaurant not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const action = cleanString(body.action);
  const now = new Date().toISOString();

  if (action === 'approve') {
    restaurant.verified = true;
    restaurant.verificationMethod = 'manual';
    restaurant.verificationStatus = 'verified';
    restaurant.denialReason = undefined;
  } else if (action === 'deny') {
    restaurant.verified = false;
    restaurant.verificationStatus = 'denied';
    restaurant.denialReason = cleanString(body.denialReason) || 'Not verified.';
  } else {
    return errorJson(['Action must be approve or deny.'], 400);
  }

  restaurant.updatedAt = now;
  await writeRestaurants(restaurants);
  return json(publicRestaurant(restaurant));
};
