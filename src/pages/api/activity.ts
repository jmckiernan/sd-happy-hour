import type { APIRoute } from 'astro';
import { getSession } from '../../lib/session';
import { touchActivitySession } from '../../lib/productAnalytics';
import { json } from '../../lib/api';

export const prerender = false;

const ACTIVITY_COOKIE = 'sdhh_activity_session';

export const POST: APIRoute = async ({ cookies }) => {
  const auth = await getSession(cookies);
  if (!auth) return json({ tracked: false });
  const result = await touchActivitySession(auth.userId, cookies.get(ACTIVITY_COOKIE)?.value || null);
  cookies.set(ACTIVITY_COOKIE, result.sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 90,
  });
  return json({ tracked: true, startedNewSession: result.startedNewSession });
};

