import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../lib/api';
import { getAdminUser } from '../../../lib/admins';
import { createMerchantAccessCode, listMerchantAccessCodes } from '../../../lib/merchantEntitlements';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Admin access required.'], 401);
  return json({ codes: await listMerchantAccessCodes() });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Admin access required.'], 401);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  try {
    const generated = await createMerchantAccessCode({
      durationMonths: Number(body.durationMonths),
      maxRedemptions: Number(body.maxRedemptions ?? 1),
      expiresAt: typeof body.expiresAt === 'string' && body.expiresAt ? body.expiresAt : null,
      createdByUserId: admin.id,
    });
    // The plaintext code is returned exactly once. Only its SHA-256 hash and
    // final four characters are retained in the database.
    return json({ generated }, 201);
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not generate an access code.'], 422);
  }
};
