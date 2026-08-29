import type { APIRoute } from 'astro';
import { getVenueClaimById, updateVenueClaim } from '../../../../lib/store';
import { cleanString } from '../../../../lib/validation';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../../lib/api';
import { publishVerifiedVenue, unpublishVenueEverywhere } from '../../../../lib/venuePublishing';

export const prerender = false;

// Approve or deny a venue claim that didn't auto-verify by domain match or
// phone code (those verify and publish at claim time — see
// lib/venuePublishing.ts). `id` here is the venue_claims row id, not a user id.
//
// Approving also publishes the venue if the data pipeline had left it
// unlisted: an admin confirming the owner is the point at which we're willing
// to show it. `unpublish` is the escape hatch for taking one back down,
// including one that self-verified.
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
      await publishVerifiedVenue(claim.venueId, 'admin', admin.id, 'Manual claim approved by admin.');
      return json(updated);
    }
    if (action === 'deny') {
      const updated = await updateVenueClaim(claim.id, { status: 'denied', denialReason: cleanString(body.denialReason) || 'Not verified.' });
      return json(updated);
    }
    if (action === 'unpublish') {
      await unpublishVenueEverywhere(claim.venueId);
      return json({ venueId: claim.venueId, published: false });
    }
  } catch (err: any) {
    if (err?.code === '23505') {
      return errorJson(['This venue already has a different verified claimant — deny this one or resolve the conflict first.'], 409);
    }
    if (/venue_publications/i.test(String(err?.message || ''))) {
      return errorJson(['Venue publishing is not set up yet. Run npm run migrate, then approve again.'], 500);
    }
    console.error('PATCH /api/admin/restaurants failed', err);
    return errorJson([err?.message || 'Could not update that claim.'], 500);
  }

  return errorJson(['Action must be approve, deny, or unpublish.'], 400);
};
