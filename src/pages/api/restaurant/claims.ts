import type { APIRoute } from 'astro';
import { listVenueClaimsByUser } from '../../../lib/store';
import { getSession } from '../../../lib/session';
import { json } from '../../../lib/api';
import { getMergedVenues } from '../../../lib/venueContent';
import { getListingImage, getVenues, venueSlug } from '../../../lib/venues';
import { listManagedVenueAccessByUser } from '../../../lib/venueUsers';

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
  const [ownerClaims, managedAccess, mergedVenues] = await Promise.all([
    listVenueClaimsByUser(session.userId),
    listManagedVenueAccessByUser(session.userId),
    getMergedVenues(),
  ]);
  const claims = [
    ...ownerClaims.map((claim) => ({ ...claim, accessRole: 'owner' as const })),
    ...managedAccess.map((access) => ({
      id: access.manager_id,
      userId: session.userId,
      venueId: access.venue_id,
      status: 'verified' as const,
      verificationMethod: null,
      phone: '',
      phoneVerifiedAt: null,
      claimNote: '',
      plan: access.plan,
      smsFundingEnabled: false,
      createdAt: '',
      updatedAt: '',
      accessRole: access.role,
    })),
  ];
  const enriched = claims.map((claim) => {
    const venue = baseVenues.find((v) => v.id === claim.venueId);
    const scheduleVenue = mergedVenues.find((v) => v.id === claim.venueId);
    // Prefer the merged listing so owner-chosen featured photos win over the
    // deploy-time JSON image / vibe stock photo.
    const imageVenue = scheduleVenue || venue;
    return {
      ...claim,
      venueName: venue?.name ?? null,
      // For linking to /restaurant/manage/<slug>/ and /venues/<slug>/ — the
      // same slug rule those routes are generated with.
      venueSlug: venue ? venueSlug(venue) : null,
      venueNeighborhood: venue?.neighborhood ?? null,
      venuePhoneAvailable: Boolean(venue?.phone),
      venueImageUrl: imageVenue ? getListingImage(imageVenue, 'card') : null,
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
