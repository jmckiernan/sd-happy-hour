import type { APIRoute } from 'astro';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'node:crypto';
import { upsertUserByGoogle, listSavedSpots, listAlerts, listVenueClaimsByUser } from '../../../lib/store';
import { publicUser, cleanString } from '../../../lib/validation';
import { createSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';
import { captureProductEvent } from '../../../lib/productAnalytics';
import { verifiedOwnerDashboardPath } from '../../../lib/authRedirect';

export const prerender = false;

const GOOGLE_CLIENT_ID = import.meta.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

export const POST: APIRoute = async ({ request, cookies }) => {
  if (!googleClient || !GOOGLE_CLIENT_ID) {
    return errorJson(['Google login is not configured. Set GOOGLE_CLIENT_ID.'], 503);
  }

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: cleanString(body.credential),
      audience: GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    return errorJson(['Google sign-in could not be verified.'], 401);
  }

  if (!payload?.email || !payload?.sub || payload.email_verified !== true) {
    return errorJson(['Google account email must be verified.'], 401);
  }

  const email = payload.email.toLowerCase();

  // One atomic upsert (README-NEON-MIGRATION.md §5) replacing the old
  // find-by-googleId-or-email → mutate-or-push → writeUsers. Links google_id
  // onto an existing password account instead of creating a duplicate, same
  // as before, but now enforced by the database's ON CONFLICT rather than an
  // in-memory find.
  const user = await upsertUserByGoogle({
    email,
    googleId: payload.sub,
    name: cleanString(payload.name) || email.split('@')[0],
    picture: cleanString(payload.picture),
    shareId: crypto.randomBytes(8).toString('hex'),
  });

  if (user.accountStatus !== 'active') {
    return errorJson(['This account is inactive. Contact support if you believe this is a mistake.'], 403);
  }

  await createSession(cookies, user.id);
  await captureProductEvent({ eventName: 'login_completed', userId: user.id, properties: { method: 'google' } });
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
