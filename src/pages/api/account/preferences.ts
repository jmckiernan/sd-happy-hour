import type { APIRoute } from 'astro';
import { getUserById, updateUserPreferences, listSavedSpots, listAlerts } from '../../../lib/store';
import { publicUser, cleanString, normalizeUsPhone } from '../../../lib/validation';
import { getSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';
import { setLocationAnalyticsConsent } from '../../../lib/productAnalytics';

export const prerender = false;

// Notification preferences from the "Preferences" section of /account/
// (the merged My Stuff page) — the weekly marketing digest opt-in, and the
// phone number + consent needed for the text channel on alerts. Distinct
// from per-alert channel toggles, which stay on each alert itself.
export const PUT: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const smsOptIn = Boolean(body.smsOptIn);
  const phoneInput = cleanString(body.phone).slice(0, 20);
  if (smsOptIn && !phoneInput) {
    return errorJson(['Add a phone number to turn on text alerts.'], 422);
  }
  let phone = '';
  if (phoneInput) {
    const normalized = normalizeUsPhone(phoneInput);
    if (normalized === null) {
      return errorJson(['That phone number doesn’t look valid.'], 422);
    }
    phone = normalized;
  }

  const updated = await updateUserPreferences(user.id, {
    phone,
    smsConsentAt: smsOptIn ? new Date().toISOString() : null,
    weeklyDigestOptIn: Boolean(body.weeklyDigestOptIn),
  });
  if (!updated) return errorJson(['User not found.'], 404);
  await setLocationAnalyticsConsent(user.id, Boolean(body.locationAnalyticsOptIn));
  const refreshed = await getUserById(user.id);
  if (!refreshed) return errorJson(['User not found.'], 404);
  const [savedSpots, alerts] = await Promise.all([listSavedSpots(refreshed.id), listAlerts(refreshed.id)]);
  return json(publicUser(refreshed, savedSpots, alerts));
};
