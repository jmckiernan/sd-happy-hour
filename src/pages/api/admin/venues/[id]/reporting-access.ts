import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../../lib/api';
import { getAdminUser } from '../../../../../lib/admins';
import {
  getMerchantEntitlement,
  grantMerchantReportingAccess,
  revokeMerchantReportingAccess,
} from '../../../../../lib/merchantEntitlements';

export const prerender = false;

export const GET: APIRoute = async ({ params, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Admin access required.'], 401);
  return json({ entitlement: await getMerchantEntitlement(Number(params.id)) });
};

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Admin access required.'], 401);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  try {
    const duration = body.durationMonths === null || body.durationMonths === '' || body.durationMonths === undefined
      ? null
      : Number(body.durationMonths);
    const entitlement = await grantMerchantReportingAccess({
      venueId: Number(params.id),
      grantedByUserId: admin.id,
      durationMonths: duration,
    });
    return json({ entitlement });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not grant reporting access.'], 422);
  }
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Admin access required.'], 401);
  await revokeMerchantReportingAccess(Number(params.id));
  return json({ revoked: true });
};
