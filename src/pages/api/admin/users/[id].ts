import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../lib/admins';
import {
  AdminUserMutationError,
  getAdminUserDetail,
  mutateUserAccount,
} from '../../../../lib/adminUsers';
import type { AdminAccountAction } from '../../../../lib/adminUserPolicy';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { getVenues } from '../../../../lib/venues';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Super-admin access required.'], 401);
  const detail = await getAdminUserDetail(params.id!);
  if (!detail) return errorJson(['User not found.'], 404);
  const venueNames = new Map(getVenues().map((venue) => [venue.id, venue.name]));
  return json({
    ...detail,
    claims: detail.claims.map((claim: any) => ({
      ...claim,
      venueName: venueNames.get(claim.venue_id) || `Venue #${claim.venue_id}`,
    })),
    managers: detail.managers.map((manager: any) => ({
      ...manager,
      venueName: venueNames.get(manager.venue_id) || `Venue #${manager.venue_id}`,
    })),
  });
};

export const PATCH: APIRoute = async ({ cookies, params, request }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Super-admin access required.'], 401);
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const action = String(body.action || '') as AdminAccountAction;
  if (!['deactivate', 'reactivate', 'anonymize'].includes(action)) {
    return errorJson(['Choose deactivate, reactivate, or anonymize.'], 422);
  }
  try {
    const result = await mutateUserAccount({
      actor: admin,
      targetUserId: params.id!,
      action,
      reason: body.reason,
      transferToEmail: body.transferToEmail,
    });
    return json(result);
  } catch (error) {
    if (error instanceof AdminUserMutationError) return errorJson([error.message], error.status);
    throw error;
  }
};
