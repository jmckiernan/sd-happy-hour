import type { APIRoute } from 'astro';
import { getVenueClaimByUserAndVenue, setLiveOverride } from '../../../lib/store';
import { getSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// The "We're live now" toggle on the restaurant dashboard. Since a user can
// now hold claims on more than one venue (see the 2026-08-12 redesign),
// venueId comes from the request body instead of being implied by a
// single-restaurant session — every request re-checks that the signed-in
// user actually holds a *verified* claim on that specific venue.
const OVERRIDE_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours — typical happy hour window

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const venueId = Number(body.venueId);
  const claim = await getVenueClaimByUserAndVenue(session.userId, venueId);
  if (!claim || claim.status !== 'verified') {
    return errorJson(['You need a verified claim on this listing before going live.'], 403);
  }

  const active = Boolean(body.active);
  const now = new Date();

  if (active) {
    const since = now.toISOString();
    const expiresAt = new Date(now.getTime() + OVERRIDE_DURATION_MS).toISOString();
    await setLiveOverride(venueId, { since, expiresAt });
    return json({ venueId, override: { active: true, since, expiresAt } });
  }

  await setLiveOverride(venueId, null);
  return json({ venueId, override: null });
};
