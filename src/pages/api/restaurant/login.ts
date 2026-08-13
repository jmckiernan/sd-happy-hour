import type { APIRoute } from 'astro';
import { getRestaurantByEmail } from '../../../lib/store';
import { publicRestaurant, verifyPassword, cleanString } from '../../../lib/validation';
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
  const restaurant = await getRestaurantByEmail(email);
  if (!restaurant || !verifyPassword(password, restaurant)) {
    return errorJson(['Invalid email or password.'], 401);
  }

  await createSession(cookies, { role: 'restaurant', restaurantId: restaurant.id });
  return json(publicRestaurant(restaurant), 200);
};
