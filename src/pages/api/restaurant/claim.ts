import type { APIRoute } from 'astro';
import { getRestaurantById, updateRestaurant } from '../../../lib/store';
import { publicRestaurant, cleanString } from '../../../lib/validation';
import { getRestaurantSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// Submits (or updates) the supporting info an admin reviews at
// /admin/restaurants/ for accounts that didn't auto-verify by domain match
// — e.g. "we run a Toast/Square page at joesbar.example, here's a link to
// our liquor license" (see the alerts spec, "Restaurant Verification").
// Submitting doesn't change status by itself; an admin still has to
// approve or deny it.
export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getRestaurantSession(cookies);
  if (!session) return errorJson(['Restaurant login required.'], 401);

  const restaurant = await getRestaurantById(session.restaurantId);
  if (!restaurant) return errorJson(['Restaurant not found.'], 404);

  if (restaurant.verified) {
    return errorJson(['This account is already verified.'], 422);
  }

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const claimNote = cleanString(body.claimNote).slice(0, 1000);
  if (!claimNote) return errorJson(['Add some supporting info before submitting.'], 422);

  const updated = await updateRestaurant(restaurant.id, {
    claimNote,
    verificationStatus: 'pending',
    denialReason: null,
  });
  if (!updated) return errorJson(['Restaurant not found.'], 404);
  return json(publicRestaurant(updated));
};
