import type { APIRoute } from 'astro';
import { getUserByEmail, listSavedSpots, listAlerts, listVenueClaimsByUser } from '../../../lib/store';
import { publicUser, verifyPassword, cleanString } from '../../../lib/validation';
import { createSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';
import { captureProductEvent } from '../../../lib/productAnalytics';
import { verifiedOwnerDashboardPath } from '../../../lib/authRedirect';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const email = cleanString(body.email).toLowerCase();
  const password = String(body.password || '');
  const user = await getUserByEmail(email);
  if (!user || !verifyPassword(password, user)) {
    return errorJson(['Invalid email or password.'], 401);
  }
  if (user.accountStatus !== 'active') {
    return errorJson(['This account is inactive. Contact support if you believe this is a mistake.'], 403);
  }

  await createSession(cookies, user.id);
  await captureProductEvent({ eventName: 'login_completed', userId: user.id, properties: { method: 'password' } });
  const [savedSpots, alerts, claims] = await Promise.all([
    listSavedSpots(user.id),
    listAlerts(user.id),
    listVenueClaimsByUser(user.id),
  ]);
  return json({
    ...publicUser(user, savedSpots, alerts),
    restaurantDashboardPath: verifiedOwnerDashboardPath(claims),
  }, 200);
};
