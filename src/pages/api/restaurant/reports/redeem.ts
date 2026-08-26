import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { authorizeMerchantReport, redeemMerchantAccessCode } from '../../../../lib/merchantEntitlements';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const venueId = Number(body.venueId);
  const authorization = await authorizeMerchantReport(cookies, venueId, { requirePaid: false });
  if (!authorization) return errorJson(['Restaurant owner access is required.'], 403);
  if (authorization.venue.role !== 'owner') {
    return errorJson(['Only the restaurant owner can redeem an access code.'], 403);
  }
  try {
    const entitlement = await redeemMerchantAccessCode({
      code: String(body.code || ''),
      venueId,
      userId: authorization.userId,
    });
    return json({ entitlement });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not redeem this access code.'], 422);
  }
};
