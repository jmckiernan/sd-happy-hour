import type { APIRoute } from 'astro';
import { readRestaurants, readLiveOverrides, writeLiveOverrides } from '../../../lib/kv';
import { getRestaurantSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// The "We're live now" toggle on the restaurant dashboard — this is the
// manual trigger from the alerts spec's notification section, alongside
// the schedule-based auto-live check. Writes to the small, separate
// live-overrides store (not the static happy-hours.json) so it's cheap and
// instant. Overrides auto-expire after a few hours so a forgotten toggle
// doesn't stay "live" indefinitely.
const OVERRIDE_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours — typical happy hour window

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getRestaurantSession(cookies);
  if (!session) return errorJson(['Restaurant login required.'], 401);

  const restaurants = await readRestaurants();
  const restaurant = restaurants.find((item) => item.id === session.restaurantId);
  if (!restaurant) return errorJson(['Restaurant not found.'], 404);
  if (!restaurant.verified) return errorJson(['Verify your account before going live.'], 403);
  if (restaurant.venueId == null) return errorJson(['Claim your listing before going live.'], 422);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const active = Boolean(body.active);
  const overrides = await readLiveOverrides();
  const now = new Date();

  if (active) {
    overrides[restaurant.venueId] = {
      active: true,
      since: now.toISOString(),
      expiresAt: new Date(now.getTime() + OVERRIDE_DURATION_MS).toISOString(),
    };
  } else {
    delete overrides[restaurant.venueId];
  }

  await writeLiveOverrides(overrides);
  return json({ venueId: restaurant.venueId, override: overrides[restaurant.venueId] || null });
};
