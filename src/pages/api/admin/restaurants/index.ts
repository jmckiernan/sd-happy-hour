import type { APIRoute } from 'astro';
import { readRestaurants, publicRestaurant } from '../../../../lib/kv';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson } from '../../../../lib/api';

export const prerender = false;

// List of restaurant accounts for admin review at /admin/restaurants/ —
// includes verified/denied too (not just pending) so admins have context,
// but the UI leads with pending since that's the actionable queue.
export const GET: APIRoute = async ({ cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  const restaurants = await readRestaurants();
  return json(restaurants.map(publicRestaurant));
};
