import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../lib/admins';
import { AdminUserQueryError, listAdminUsers } from '../../../../lib/adminUsers';
import { errorJson, json } from '../../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, url }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Super-admin access required.'], 401);
  try {
    const result = await listAdminUsers({
      search: url.searchParams.get('search') || '',
      status: url.searchParams.get('status') || '',
      role: url.searchParams.get('role') || '',
      days: Number(url.searchParams.get('days') || 30),
      limit: Number(url.searchParams.get('limit') || 50),
      cursor: url.searchParams.get('cursor'),
    });
    return json(result);
  } catch (error) {
    if (error instanceof AdminUserQueryError) return errorJson([error.message], error.status);
    throw error;
  }
};

