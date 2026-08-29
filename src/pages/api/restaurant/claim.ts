import type { APIRoute } from 'astro';
import { getUserById, getVenueClaimByUserAndVenue, createVenueClaim, updateVenueClaim } from '../../../lib/store';
import { cleanString, extractDomain } from '../../../lib/validation';
import { getSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';
import { getVenues } from '../../../lib/venues';
import { publishVerifiedVenue } from '../../../lib/venuePublishing';

export const prerender = false;

// Claim a specific venue listing. Restaurants no longer have a separate
// account (see the 2026-08-12 redesign) — any signed-in user can claim a
// venue, but verification is now scoped to *this* venue rather than
// self-reported at signup:
//
//   - If the signed-in Google account's email domain matches *this venue's
//     own* website domain (from happy-hours.json), the claim auto-verifies
//     instantly.
//   - Otherwise the claim lands in `pending` with no verification method
//     chosen yet. The response tells the client whether phone verification
//     is available (venue.phone set) so the dashboard can offer "text me a
//     code" (see claim/send-code.ts) ahead of manual review — resubmit this
//     same endpoint with a claimNote for the manual-review path.
//
// venue_claims_verified_venue_unique (the DB) enforces that at most one
// account can hold a verified claim on a given venue at a time — the actual
// fix for "claim any restaurant you want."
export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to claim a listing.'], 401);

  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const venueId = Number(body.venueId);
  const venue = getVenues().find((v) => v.id === venueId);
  if (!venue) return errorJson(['Venue not found.'], 404);

  const existing = await getVenueClaimByUserAndVenue(user.id, venueId);
  if (existing?.status === 'verified') {
    // Already verified — nothing to do, just hand back the current record.
    return json({ claim: existing, venuePhoneAvailable: Boolean(venue.phone) });
  }

  const emailDomain = extractDomain(user.email);
  const venueDomain = extractDomain(venue.website);
  const domainMatches = Boolean(emailDomain) && emailDomain === venueDomain;

  try {
    if (domainMatches) {
      const claim = existing
        ? await updateVenueClaim(existing.id, { status: 'verified', verificationMethod: 'domain', denialReason: null })
        : await createVenueClaim({ userId: user.id, venueId, status: 'verified', verificationMethod: 'domain' });
      // An email on the venue's own domain is proof enough to publish: if the
      // pipeline left this venue unlisted, the owner turning up outranks that.
      // Manual claims are the ones that wait for admin review.
      await publishVerifiedVenue(venueId, 'domain', user.id);
      return json({ claim, venuePhoneAvailable: Boolean(venue.phone) }, existing ? 200 : 201);
    }

    const claimNote = cleanString(body.claimNote);
    if (claimNote) {
      // Explicit manual-review submission.
      const claim = existing
        ? await updateVenueClaim(existing.id, { status: 'pending', verificationMethod: 'manual', claimNote: claimNote.slice(0, 1000), denialReason: null })
        : await createVenueClaim({ userId: user.id, venueId, status: 'pending', verificationMethod: 'manual', claimNote: claimNote.slice(0, 1000) });
      return json({ claim, venuePhoneAvailable: Boolean(venue.phone) }, existing ? 200 : 201);
    }

    // No domain match, no note yet — create/return a bare pending claim so
    // the dashboard can offer phone verification (or the note form) next.
    const claim = existing ?? (await createVenueClaim({ userId: user.id, venueId, status: 'pending', verificationMethod: null }));
    return json({ claim, venuePhoneAvailable: Boolean(venue.phone) }, existing ? 200 : 201);
  } catch (err: any) {
    if (err?.code === '23505') {
      return errorJson(['This listing has already been claimed and verified by another account.'], 409);
    }
    throw err;
  }
};
