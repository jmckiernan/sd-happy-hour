import type { APIRoute } from 'astro';
import { readRestaurants, publicRestaurant } from '../../../lib/kv';
import { getRestaurantSession } from '../../../lib/session';
import { json } from '../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getRestaurantSession(cookies);
  if (!session) return json({ authenticated: false, restaurant: null });

  const restaurants = await readRestaurants();
  const restaurant = restaurants.find((item) => item.id === session.restaurantId);
  return json({ authenticated: Boolean(restaurant), restaurant: restaurant ? publicRestaurant(restaurant) : null });
};
