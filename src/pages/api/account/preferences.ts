import type { APIRoute } from 'astro';
import { readUsers, writeUsers, publicUser, cleanString } from '../../../lib/kv';
import { getSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

export const prerender = false;

// Notification preferences from the "Preferences" section of /account/
// (the merged My Stuff page) — the weekly marketing digest opt-in, and the
// phone number + consent needed for the text channel on alerts (see
// User.phone/smsConsentAt in lib/kv.ts). Distinct from per-alert channel
// toggles, which stay on each alert itself.
export const PUT: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  const users = await readUsers();
  const user = users.find((item) => item.id === session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const smsOptIn = Boolean(body.smsOptIn);
  const phone = cleanString(body.phone).slice(0, 20);
  if (smsOptIn && !phone) {
    return errorJson(['Add a phone number to turn on text alerts.'], 422);
  }
  if (phone && !/^\+?[0-9()\-.\s]{7,20}$/.test(phone)) {
    return errorJson(['That phone number doesn’t look valid.'], 422);
  }

  user.phone = phone;
  user.smsConsentAt = smsOptIn ? new Date().toISOString() : null;
  user.weeklyDigestOptIn = Boolean(body.weeklyDigestOptIn);
  user.updatedAt = new Date().toISOString();
  await writeUsers(users);
  return json(publicUser(user));
};
