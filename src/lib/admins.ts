import type { AstroCookies } from 'astro';
import { getSession } from './session';
import { getUserById, type User } from './store';

// The only site admins — full privileges (review/approve/deny submissions,
// generate blog posts) come from signing in with one of these emails via
// the normal Google/email login at /account/. There's no separate admin
// username/password anymore.
export const ADMIN_EMAILS = ['jmckiernan86@gmail.com', 'shanewlykins@gmail.com'];

/**
 * Returns the signed-in User if their account's email is an admin email,
 * else null. Use this to gate every admin-only page/API route.
 */
export async function getAdminUser(cookies: AstroCookies): Promise<User | null> {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return null;

  const user = await getUserById(session.userId);
  if (!user || !ADMIN_EMAILS.includes(user.email)) return null;
  return user;
}
