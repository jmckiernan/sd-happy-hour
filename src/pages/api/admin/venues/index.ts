import type { APIRoute } from 'astro';
import { listVenueClaims, getUserById, listPublishedVenueIds } from '../../../../lib/store';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson } from '../../../../lib/api';
import { getVenues, venueSlug } from '../../../../lib/venues';
import { getMerchantEntitlement } from '../../../../lib/merchantEntitlements';

export const prerender = false;

// Admin venue directory for /admin/venues/ — every venue in the catalog plus
// all claims attached to it, so the UI can tab by pending/verified/unverified/
// denied without a round trip per filter.
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

    const enrichedClaims = await Promise.all(claims.map(async (claim) => {
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
        id: claim.id,
        userId: claim.userId,
        venueId: claim.venueId,
        status: claim.status,
        verificationMethod: claim.verificationMethod,
        claimNote: claim.claimNote,
        denialReason: claim.denialReason ?? null,
        createdAt: claim.createdAt,
        verifiedAt: claim.verifiedAt,
        userName: user?.name ?? 'Unknown',
        userEmail: user?.email ?? 'unknown',
        reportingEntitlement,
      };
    }));

    const claimsByVenue = new Map<number, typeof enrichedClaims>();
    for (const claim of enrichedClaims) {
      const bucket = claimsByVenue.get(claim.venueId) ?? [];
      bucket.push(claim);
      claimsByVenue.set(claim.venueId, bucket);
    }

    const verifiedVenueIds = new Set(
      enrichedClaims.filter((c) => c.status === 'verified').map((c) => c.venueId),
    );

    const directory = venues.map((venue) => ({
      id: venue.id,
      name: venue.name,
      slug: venueSlug(venue),
      neighborhood: venue.neighborhood,
      address: venue.address,
      website: venue.website ?? '',
      phone: venue.phone ?? '',
      vibe: venue.vibe ?? '',
      deals: venue.deals ?? [],
      listingStatus: venue.listingStatus ?? 'published',
      publishedByClaim: publishedVenueIds.has(venue.id),
      ownerVerified: verifiedVenueIds.has(venue.id),
      claims: claimsByVenue.get(venue.id) ?? [],
    }));

    return json({ venues: directory, claimCount: enrichedClaims.length });
  } catch (error: any) {
    console.error('GET /api/admin/venues failed', error);
    return errorJson([error?.message || 'Could not load venues.'], 500);
  }
};
