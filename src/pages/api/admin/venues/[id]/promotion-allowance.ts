import type { APIRoute } from 'astro';
import { errorJson, json } from '../../../../../lib/api';
import { getAdminUser } from '../../../../../lib/admins';
import { withTransaction, type QueryExecutor } from '../../../../../lib/db';
import { getPromotionEntitlement } from '../../../../../lib/promotionEntitlements';
import {
  addPromotionAllowance,
  getAdditionalPromotionAllowance,
  removePromotionAllowance,
} from '../../../../../lib/promotionAllowanceRepo';
import { getVerifiedPromotionClaimByVenue } from '../../../../../lib/promotionAuthorization';
import {
  getDatabaseNow,
  listPromotionCampaignsByVenue,
  lockPromotionVenue,
} from '../../../../../lib/promotionRepo';
import { getSanDiegoMonthKey } from '../../../../../lib/sanDiegoTime';
import { getVenueById } from '../../../../../lib/venues';

export const prerender = false;

function venueIdFrom(value: string | undefined): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function currentAllowance(venueId: number, executor: QueryExecutor, databaseNow?: string) {
  const now = databaseNow ?? await getDatabaseNow(executor);
  const monthKey = getSanDiegoMonthKey(now);
  const [claim, promotions, additionalAllowance] = await Promise.all([
    getVerifiedPromotionClaimByVenue(venueId, executor),
    listPromotionCampaignsByVenue(venueId, executor),
    getAdditionalPromotionAllowance(venueId, monthKey, executor),
  ]);
  return {
    serverNow: now,
    entitlement: getPromotionEntitlement({
      plan: claim?.plan ?? 'free',
      venueId,
      promotions,
      now,
      monthKey,
      additionalAllowance,
    }),
  };
}

async function authorize(cookies: Parameters<typeof getAdminUser>[0], rawId: string | undefined) {
  const admin = await getAdminUser(cookies);
  if (!admin) return { response: errorJson(['Admin sign-in required.'], 401) } as const;
  const venueId = venueIdFrom(rawId);
  if (!venueId) return { response: errorJson(['Invalid venue id.'], 400) } as const;
  if (!getVenueById(venueId)) return { response: errorJson(['Venue not found.'], 404) } as const;
  return { admin, venueId } as const;
}

export const GET: APIRoute = async ({ params, cookies }) => {
  const auth = await authorize(cookies, params.id);
  if ('response' in auth) return auth.response;
  try {
    return json(await withTransaction((tx) => currentAllowance(auth.venueId, tx)));
  } catch (error: any) {
    return errorJson([`Could not load promotion availability: ${error.message}`], 502);
  }
};

export const POST: APIRoute = async ({ params, cookies }) => {
  const auth = await authorize(cookies, params.id);
  if ('response' in auth) return auth.response;
  try {
    const result = await withTransaction(async (tx) => {
      // Shares the same venue lock as publishing, so a grant and a launch
      // cannot race into a stale quota decision.
      await lockPromotionVenue(tx, auth.venueId);
      const now = await getDatabaseNow(tx);
      await addPromotionAllowance(
        tx,
        auth.venueId,
        getSanDiegoMonthKey(now),
        auth.admin.id
      );
      return currentAllowance(auth.venueId, tx, now);
    });
    return json(result);
  } catch (error: any) {
    return errorJson([`Could not add a promotion: ${error.message}`], 502);
  }
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const auth = await authorize(cookies, params.id);
  if ('response' in auth) return auth.response;
  try {
    const result = await withTransaction(async (tx) => {
      await lockPromotionVenue(tx, auth.venueId);
      const now = await getDatabaseNow(tx);
      const removed = await removePromotionAllowance(
        tx,
        auth.venueId,
        getSanDiegoMonthKey(now),
        auth.admin.id
      );
      if (!removed) return null;
      return currentAllowance(auth.venueId, tx, now);
    });
    if (!result) return errorJson(['There are no admin-added promotions to remove.'], 409);
    return json(result);
  } catch (error: any) {
    return errorJson([`Could not remove a promotion: ${error.message}`], 502);
  }
};
