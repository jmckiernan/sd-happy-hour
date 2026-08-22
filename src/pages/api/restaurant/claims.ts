import type { APIRoute } from 'astro';
import { listVenueClaimsByUser } from '../../../lib/store';
import { getSession } from '../../../lib/session';
import { json } from '../../../lib/api';
import { getMergedVenues } from '../../../lib/venueContent';
import { getVenues, slugify } from '../../../lib/venues';

export const prerender = false;

// The signed-in user's venue claims (replaces the old /api/restaurant/me —
// there's no separate restaurant "account" anymore, just claims attached to
// a regular user). Joins in venue name/neighborhood from happy-hours.json
// for display since venue_claims only stores the numeric venue_id.
export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  if (!session) {
    return json({ authenticated: false, serverNow: new Date().toISOString(), claims: [] });
  }

  const baseVenues = getVenues();
  const [claims, mergedVenues] = await Promise.all([
    listVenueClaimsByUser(session.userId),
    getMergedVenues(),
  ]);
  const enriched = claims.map((claim) => {
    const venue = baseVenues.find((v) => v.id === claim.venueId);
    const scheduleVenue = mergedVenues.find((v) => v.id === claim.venueId);
    return {
      ...claim,
      venueName: venue?.name ?? null,
      // For linking to /restaurant/manage/<slug>/ and /venues/<slug>/ — the
      // same slug rule those routes are generated with.
      venueSlug: venue ? slugify(venue.name) : null,
      venueNeighborhood: venue?.neighborhood ?? null,
      venuePhoneAvailable: Boolean(venue?.phone),
      // The dashboard's informational recurring-hours block must reflect the
      // owner's latest listing override, not just the deploy-time JSON record.
      happyHourSchedule: scheduleVenue ? {
        id: scheduleVenue.id,
        days: scheduleVenue.days,
        startTime: scheduleVenue.startTime,
        endTime: scheduleVenue.endTime,
      } : null,
    };
  });

  return json({ authenticated: true, serverNow: new Date().toISOString(), claims: enriched });
};
