import type { APIRoute } from 'astro';
import { listVenueClaims, getUserById, listPublishedVenueIds } from '../../../../lib/store';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson } from '../../../../lib/api';
import { getVenues } from '../../../../lib/venues';
import { getMerchantEntitlement } from '../../../../lib/merchantEntitlements';

export const prerender = false;

// List of venue claims for admin review at /admin/venues/ — includes
// verified/denied too (not just pending) so admins have context, but the UI
// leads with pending since that's the actionable queue. Joins in the
// claiming user's name/email and the venue's name (venue_claims only stores
// user_id/venue_id) so the review card can show who's asking for what.
export const GET: APIRoute = async ({ cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  try {
    const [claims, publishedVenueIds] = await Promise.all([
      listVenueClaims(),
      listPublishedVenueIds(),
    ]);
    const venues = getVenues();
    const userIds = [...new Set(claims.map((c) => c.userId))];
    const users = await Promise.all(userIds.map((id) => getUserById(id)));
    const usersById = new Map(users.filter(Boolean).map((u) => [u!.id, u!]));

    const enriched = await Promise.all(claims.map(async (claim) => {
      const venue = venues.find((v) => v.id === claim.venueId);
      const user = usersById.get(claim.userId);
      let reportingEntitlement = null;
      if (claim.status === 'verified') {
        try {
          reportingEntitlement = await getMerchantEntitlement(claim.venueId);
        } catch {
          reportingEntitlement = null;
        }
      }
      return {
        ...claim,
        verifiedAt: claim.verifiedAt,
        venueName: venue?.name ?? `Venue #${claim.venueId}`,
        venueWebsite: venue?.website ?? null,
        // Whether the venue is on the public site, and whether it's there
        // because a claim cleared it rather than on its own data. Lets the
        // review card show that approving will publish it, and offer to undo.
        venueListingStatus: venue?.listingStatus ?? 'published',
        venuePublishedByClaim: publishedVenueIds.has(claim.venueId),
        userName: user?.name ?? 'Unknown',
        userEmail: user?.email ?? 'unknown',
        reportingEntitlement,
      };
    }));

    return json(enriched);
  } catch (error: any) {
    console.error('GET /api/admin/restaurants failed', error);
    return errorJson([error?.message || 'Could not load venue claims.'], 500);
  }
};
