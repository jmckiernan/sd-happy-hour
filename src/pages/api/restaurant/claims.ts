import type { APIRoute } from 'astro';
import { listVenueClaimsByUser } from '../../../lib/store';
import { getSession } from '../../../lib/session';
import { json } from '../../../lib/api';
import { getVenues } from '../../../lib/venues';

export const prerender = false;

// The signed-in user's venue claims (replaces the old /api/restaurant/me —
// there's no separate restaurant "account" anymore, just claims attached to
// a regular user). Joins in venue name/neighborhood from happy-hours.json
// for display since venue_claims only stores the numeric venue_id.
export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  if (!session) return json({ authenticated: false, claims: [] });

  const claims = await listVenueClaimsByUser(session.userId);
  const venues = getVenues();
  const enriched = claims.map((claim) => {
    const venue = venues.find((v) => v.id === claim.venueId);
    return {
      ...claim,
      venueName: venue?.name ?? null,
      venueNeighborhood: venue?.neighborhood ?? null,
      venuePhoneAvailable: Boolean(venue?.phone),
    };
  });

  return json({ authenticated: true, claims: enriched });
};
