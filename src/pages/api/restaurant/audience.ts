import type { APIRoute } from 'astro';
import { errorJson, json } from '../../../lib/api';
import { isAdminEmail } from '../../../lib/adminIdentity';
import { getMerchantAudienceDetail } from '../../../lib/merchantAudience';
import { listMerchantReportVenues } from '../../../lib/merchantEntitlements';
import { getSession } from '../../../lib/session';
import { getUserById } from '../../../lib/store';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);
  const user = await getUserById(session.userId);
  if (!user) return errorJson(['Account not found.'], 401);

  const venues = await listMerchantReportVenues(user.id, isAdminEmail(user.email));
  const publicVenues = venues.map(({ ownerUserId: _ownerUserId, ...item }) => item);
  const venueId = Number(url.searchParams.get('venueId'));
  const venue = venues.find((item) => item.venueId === venueId);
  if (!venue) return errorJson(['You do not have reporting access for this restaurant.'], 403);
  // Same paid gate as reports so free venues do not get a second unpaid analytics surface.
  if (!venue.paid) {
    return json(
      { code: 'paid_required', errors: ['Audience requires paid reporting access.'], venues: publicVenues },
      402
    );
  }

  const audience = await getMerchantAudienceDetail(venueId);
  return json({ audience, venues: publicVenues });
};
