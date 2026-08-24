import type { APIRoute } from 'astro';
import { getUserById, listAlerts } from '../../../lib/store';
import { getUnifiedSavedState, projectLegacySavedSpots } from '../../../lib/savedLists';
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

  const [saved, alerts] = await Promise.all([getUnifiedSavedState(user.id), listAlerts(user.id)]);
  return json({ authenticated: true, user: publicUser(user, projectLegacySavedSpots(saved), alerts, saved) });
};
