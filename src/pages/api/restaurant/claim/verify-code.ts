import type { APIRoute } from 'astro';
import { getUserById, getVenueClaimByUserAndVenue, verifyVenueClaimPhoneCode } from '../../../../lib/store';
import { cleanString } from '../../../../lib/validation';
import { getSession } from '../../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../../lib/api';
import { publishVerifiedVenue } from '../../../../lib/venuePublishing';

export const prerender = false;

// Completes phone verification for a claim (see send-code.ts). The actual
// check + status flip to 'verified' happens atomically inside
// verifyVenueClaimPhoneCode (store.ts) so there's no read-then-write race.
export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const venueId = Number(body.venueId);
  const code = cleanString(body.code);
  if (!code) return errorJson(['Enter the code you were texted.'], 422);

  const claim = await getVenueClaimByUserAndVenue(user.id, venueId);
  if (!claim) return errorJson(['No pending claim found for this listing — request a code first.'], 404);

  try {
    const verified = await verifyVenueClaimPhoneCode(claim.id, code);
    if (!verified) return errorJson(['That code is incorrect or has expired. Request a new one and try again.'], 422);
    // Same standard as the domain match in claim.ts: a code texted to the
    // venue's own listed number proves ownership, so publish right away.
    await publishVerifiedVenue(venueId, 'phone', user.id);
    return json(verified);
  } catch (err: any) {
    if (err?.code === '23505') {
      return errorJson(['This listing has already been claimed and verified by another account.'], 409);
    }
    throw err;
  }
};
