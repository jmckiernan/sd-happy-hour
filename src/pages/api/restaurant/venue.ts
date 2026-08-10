import type { APIRoute } from 'astro';
import { readRestaurants, writeRestaurants, publicRestaurant } from '../../../lib/kv';
import { getRestaurantSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';
import { getVenues } from '../../../lib/venues';

export const prerender = false;

// Links this restaurant account to one of the existing venue listings in
// public/data/happy-hours.json, so it can toggle that listing live (see
// api/restaurant/live.ts). Deliberately simple for now: the restaurant
// picks its own listing from a search, with no separate admin approval of
// the *link* itself (only identity verification is admin-reviewed) — a
// known limitation, see README-NOTIFICATIONS-SETUP.md. Only verified
// restaurants can link a venue.
export const PUT: APIRoute = async ({ request, cookies }) => {
  const session = await getRestaurantSession(cookies);
  if (!session) return errorJson(['Restaurant login required.'], 401);

  const restaurants = await readRestaurants();
  const restaurant = restaurants.find((item) => item.id === session.restaurantId);
  if (!restaurant) return errorJson(['Restaurant not found.'], 404);
  if (!restaurant.verified) return errorJson(['Verify your account before claiming a listing.'], 403);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const venueId = Number(body.venueId);
  if (!getVenues().some((v) => v.id === venueId)) {
    return errorJson(['Venue not found.'], 404);
  }

  restaurant.venueId = venueId;
  restaurant.updatedAt = new Date().toISOString();
  await writeRestaurants(restaurants);
  return json(publicRestaurant(restaurant));
};
