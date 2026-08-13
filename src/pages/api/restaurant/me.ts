import type { APIRoute } from 'astro';
import { getRestaurantById } from '../../../lib/store';
import { publicRestaurant } from '../../../lib/validation';
import { getRestaurantSession } from '../../../lib/session';
import { json } from '../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getRestaurantSession(cookies);
  if (!session) return json({ authenticated: false, restaurant: null });

  const restaurant = await getRestaurantById(session.restaurantId);
  return json({ authenticated: Boolean(restaurant), restaurant: restaurant ? publicRestaurant(restaurant) : null });
};
