import type { APIRoute } from 'astro';
import { readRestaurants, publicRestaurant, verifyPassword, cleanString } from '../../../lib/kv';
import { createSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const email = cleanString(body.email).toLowerCase();
  const password = String(body.password || '');
  const restaurants = await readRestaurants();
  const restaurant = restaurants.find((item) => item.email === email);
  if (!restaurant || !verifyPassword(password, restaurant)) {
    return errorJson(['Invalid email or password.'], 401);
  }

  await createSession(cookies, { role: 'restaurant', restaurantId: restaurant.id });
  return json(publicRestaurant(restaurant), 200);
};
