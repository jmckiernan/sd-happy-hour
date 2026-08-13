import type { APIRoute } from 'astro';
import { getVenueClaimByUserAndVenue, getPromotion, setPromotion, deletePromotion } from '../../../lib/store';
import { cleanString } from '../../../lib/validation';
import { getSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// venueId now comes from the query string / body instead of being implied
// by a single-restaurant session, since a user can hold claims on more than
// one venue (see the 2026-08-12 redesign). Every request re-checks that the
// signed-in user holds a *verified* claim on that specific venue — a
// restaurant reading back its own promotion always sees the code; the
// public gate in api/promotions.ts only applies to anonymous/consumer
// requests.
async function requireVerifiedClaim(userId: string, venueId: number) {
  if (!venueId) return null;
  const claim = await getVenueClaimByUserAndVenue(userId, venueId);
  return claim?.status === 'verified' ? claim : null;
}

export const GET: APIRoute = async ({ url, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  const venueId = Number(url.searchParams.get('venueId'));
  const claim = await requireVerifiedClaim(session.userId, venueId);
  if (!claim) return json({ promotion: null });

  const promotion = await getPromotion(venueId);
  return json({ promotion });
};

export const PUT: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const venueId = Number(body.venueId);
  const claim = await requireVerifiedClaim(session.userId, venueId);
  if (!claim) return errorJson(['You need a verified claim on this listing before promoting a deal.'], 403);

  const dealCode = cleanString(body.dealCode).slice(0, 30);
  const description = cleanString(body.description).slice(0, 200);
  if (!dealCode) return errorJson(['A deal code is required.'], 422);
  if (!description) return errorJson(['A short public description is required (e.g. "10% off your bill").'], 422);

  const promotion = await setPromotion(venueId, { dealCode, description });
  return json(promotion);
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    body = {};
  }

  const venueId = Number(body.venueId);
  const claim = await requireVerifiedClaim(session.userId, venueId);
  if (!claim) return errorJson(['You need a verified claim on this listing.'], 403);

  await deletePromotion(venueId);
  return json({ ok: true });
};
