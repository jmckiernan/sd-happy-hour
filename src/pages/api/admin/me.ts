import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../lib/admins';
import { json } from '../../../lib/api';

export const prerender = false;

// Single source of truth for "is this signed-in account an admin" — gates
// the /admin/ (submissions review) and /admin/new-post/ (blog generator)
// nav links and pages. Admin = signed in at /account/ with an email in
// ADMIN_EMAILS, not a separate admin login.
export const GET: APIRoute = async ({ cookies }) => {
  const admin = await getAdminUser(cookies);
  return json({ authenticated: Boolean(admin), email: admin?.email ?? null });
};
