import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../lib/admins';
import { listMarketAreaInsights } from '../../../../lib/adminUsers';
import { errorJson, json } from '../../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, url }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Super-admin access required.'], 401);
  return json(await listMarketAreaInsights(url.searchParams.get('days')));
};

