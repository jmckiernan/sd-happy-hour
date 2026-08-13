import type { APIRoute } from 'astro';
import { getRestaurantById, updateRestaurant } from '../../../../lib/store';
import { publicRestaurant, cleanString } from '../../../../lib/validation';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../../lib/api';

export const prerender = false;

// Approve or deny a manual-claim restaurant verification (domain-matched
// restaurants never reach this — they're auto-verified at signup). See the
// alerts spec, "Restaurant Verification".
export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  const restaurant = await getRestaurantById(params.id!);
  if (!restaurant) return errorJson(['Restaurant not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const action = cleanString(body.action);

  let updated;
  if (action === 'approve') {
    updated = await updateRestaurant(restaurant.id, {
      verified: true,
      verificationMethod: 'manual',
      verificationStatus: 'verified',
      denialReason: null,
    });
  } else if (action === 'deny') {
    updated = await updateRestaurant(restaurant.id, {
      verified: false,
      verificationStatus: 'denied',
      denialReason: cleanString(body.denialReason) || 'Not verified.',
    });
  } else {
    return errorJson(['Action must be approve or deny.'], 400);
  }

  if (!updated) return errorJson(['Restaurant not found.'], 404);
  return json(publicRestaurant(updated));
};
