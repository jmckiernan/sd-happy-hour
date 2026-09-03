import type { APIRoute } from 'astro';
import { errorJson, json } from '../../../lib/api';
import { authorizeMerchantReport, listMerchantReportVenues } from '../../../lib/merchantEntitlements';
import { getMerchantBillingSummary } from '../../../lib/merchantBilling';
import { isAdminEmail } from '../../../lib/adminIdentity';
import { getSession } from '../../../lib/session';
import { getUserById } from '../../../lib/store';

export const prerender = false;

/**
 * Billing summary for a verified owner / full_admin (or site admin).
 * Does not require paid reporting access — free venues need plan/credits visibility
 * and the redeem path. Stripe spend/invoices are stubs until Checkout ships.
 */
export const GET: APIRoute = async ({ url, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);
  const user = await getUserById(session.userId);
  if (!user) return errorJson(['Account not found.'], 401);

  const venueId = Number(url.searchParams.get('venueId'));
  if (!Number.isSafeInteger(venueId) || venueId <= 0) {
    return errorJson(['A valid venueId is required.'], 400);
  }

  const authorization = await authorizeMerchantReport(cookies, venueId, { requirePaid: false });
  if (!authorization) {
    return errorJson(['You do not have billing access for this restaurant.'], 403);
  }

  const billing = await getMerchantBillingSummary(venueId, { role: authorization.venue.role });
  if (!billing) return errorJson(['Restaurant not found.'], 404);

  const venues = await listMerchantReportVenues(user.id, isAdminEmail(user.email));
  const publicVenues = venues.map(({ ownerUserId: _ownerUserId, ...item }) => item);

  return json({
    billing,
    venues: publicVenues,
  });
};
