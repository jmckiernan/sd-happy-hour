import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { getAdminUser } from '../../../../lib/admins';
import { updateMerchantAccessCodeActive } from '../../../../lib/merchantEntitlements';

export const prerender = false;

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Admin access required.'], 401);

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  if (typeof body.active !== 'boolean') {
    return errorJson(['active must be true or false.'], 422);
  }

  try {
    const updated = await updateMerchantAccessCodeActive(params.id!, body.active);
    return json({ code: updated });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not update access code.'], 422);
  }
};
