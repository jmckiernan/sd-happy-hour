import type { APIRoute } from 'astro';
import { getVenueClaimById, updateVenueClaim } from '../../../../lib/store';
import { cleanString } from '../../../../lib/validation';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../../lib/api';

export const prerender = false;

// Approve or deny a venue claim that didn't auto-verify by domain match
// (those never reach this — they're auto-verified at claim time). `id` here
// is the venue_claims row id, not a user id.
export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  const claim = await getVenueClaimById(params.id!);
  if (!claim) return errorJson(['Claim not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const action = cleanString(body.action);

  try {
    if (action === 'approve') {
      const updated = await updateVenueClaim(claim.id, { status: 'verified', verificationMethod: 'manual', denialReason: null });
      return json(updated);
    }
    if (action === 'deny') {
      const updated = await updateVenueClaim(claim.id, { status: 'denied', denialReason: cleanString(body.denialReason) || 'Not verified.' });
      return json(updated);
    }
  } catch (err: any) {
    if (err?.code === '23505') {
      return errorJson(['This venue already has a different verified claimant — deny this one or resolve the conflict first.'], 409);
    }
    throw err;
  }

  return errorJson(['Action must be approve or deny.'], 400);
};
