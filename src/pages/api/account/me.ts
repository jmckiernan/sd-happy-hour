import type { APIRoute } from 'astro';
import { getUserById, listSavedSpots, listAlerts } from '../../../lib/store';
import { publicUser } from '../../../lib/validation';
import { getSession } from '../../../lib/session';
import { json } from '../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') {
    return json({ authenticated: false, user: null });
  }

  const user = await getUserById(session.userId);
  if (!user) return json({ authenticated: false, user: null });

  const [savedSpots, alerts] = await Promise.all([listSavedSpots(user.id), listAlerts(user.id)]);
  return json({ authenticated: true, user: publicUser(user, savedSpots, alerts) });
};
