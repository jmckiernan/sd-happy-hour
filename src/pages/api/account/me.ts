import type { APIRoute } from 'astro';
import { getUserById, listAlerts } from '../../../lib/store';
import { getUnifiedSavedState, projectLegacySavedSpots } from '../../../lib/savedLists';
import { publicUser } from '../../../lib/validation';
import { getSession } from '../../../lib/session';
import { json } from '../../../lib/api';
import { isAdminEmail } from '../../../lib/admins';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') {
    return json({ authenticated: false, user: null, isAdmin: false });
  }

  const user = await getUserById(session.userId);
  if (!user) return json({ authenticated: false, user: null, isAdmin: false });

  // Auth status must not depend on saved-list / feedback enrichment. A broken
  // or un-migrated saved-state query used to 503 here, which made
  // fetchBrowserSession treat a valid cookie as signed-out and bounced users
  // straight back to the sign-in form (or into an account↔next redirect loop).
  let savedSpots: ReturnType<typeof projectLegacySavedSpots> = [];
  let alerts: Awaited<ReturnType<typeof listAlerts>> = [];
  let saved: Awaited<ReturnType<typeof getUnifiedSavedState>> | undefined;
  try {
    const [savedState, alertRows] = await Promise.all([
      getUnifiedSavedState(user.id),
      listAlerts(user.id),
    ]);
    saved = savedState;
    savedSpots = projectLegacySavedSpots(savedState);
    alerts = alertRows;
  } catch (err) {
    console.error('[api/account/me] saved-state enrichment failed', err);
    try {
      alerts = await listAlerts(user.id);
    } catch {
      alerts = [];
    }
  }

  return json({
    authenticated: true,
    user: publicUser(user, savedSpots, alerts, saved),
    isAdmin: isAdminEmail(user.email),
  });
};
