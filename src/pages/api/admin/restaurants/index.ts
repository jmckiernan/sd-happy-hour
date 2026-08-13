import type { APIRoute } from 'astro';
import { listVenueClaims, getUserById } from '../../../../lib/store';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson } from '../../../../lib/api';
import { getVenues } from '../../../../lib/venues';

export const prerender = false;

// List of venue claims for admin review at /admin/restaurants/ — includes
// verified/denied too (not just pending) so admins have context, but the UI
// leads with pending since that's the actionable queue. Joins in the
// claiming user's name/email and the venue's name (venue_claims only stores
// user_id/venue_id) so the review card can show who's asking for what.
export const GET: APIRoute = async ({ cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  const claims = await listVenueClaims();
  const venues = getVenues();
  const userIds = [...new Set(claims.map((c) => c.userId))];
  const users = await Promise.all(userIds.map((id) => getUserById(id)));
  const usersById = new Map(users.filter(Boolean).map((u) => [u!.id, u!]));

  const enriched = claims.map((claim) => {
    const venue = venues.find((v) => v.id === claim.venueId);
    const user = usersById.get(claim.userId);
    return {
      ...claim,
      venueName: venue?.name ?? `Venue #${claim.venueId}`,
      venueWebsite: venue?.website ?? null,
      userName: user?.name ?? 'Unknown',
      userEmail: user?.email ?? 'unknown',
    };
  });

  return json(enriched);
};
