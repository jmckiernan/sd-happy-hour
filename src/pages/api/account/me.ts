import type { APIRoute } from 'astro';
import { readUsers, publicUser } from '../../../lib/kv';
import { getSession } from '../../../lib/session';
import { json } from '../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') {
    return json({ authenticated: false, user: null });
  }

  const users = await readUsers();
  const user = users.find((item) => item.id === session.userId);
  return json({ authenticated: Boolean(user), user: user ? publicUser(user) : null });
};
