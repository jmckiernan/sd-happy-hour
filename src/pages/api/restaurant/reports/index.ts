import type { APIRoute } from 'astro';
import { errorJson, json } from '../../../../lib/api';
import { isAdminEmail } from '../../../../lib/adminIdentity';
import { listMerchantReportVenues } from '../../../../lib/merchantEntitlements';
import { getMerchantReportData, resolveMerchantReportRange } from '../../../../lib/merchantReporting';
import { getSession } from '../../../../lib/session';
import { getUserById } from '../../../../lib/store';

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
  if (!venue.paid) return json({ code: 'paid_required', errors: ['Merchant reports require paid access.'], venues: publicVenues }, 402);
  let range;
  try {
    range = resolveMerchantReportRange({
      preset: url.searchParams.get('range'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Invalid report range.'], 422);
  }
  const report = await getMerchantReportData({
    venueId,
    ownerUserId: venue.ownerUserId,
    accessibleVenues: venues.filter((item) => item.paid).map((item) => ({
      venueId: item.venueId,
      ownerUserId: item.ownerUserId,
    })),
    range,
  });
  return json({ report, venues: publicVenues });
};
