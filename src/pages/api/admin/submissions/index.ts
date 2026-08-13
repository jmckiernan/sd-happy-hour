import type { APIRoute } from 'astro';
import { listSubmissions } from '../../../../lib/store';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson } from '../../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  const submissions = await listSubmissions();
  return json(submissions);
};
