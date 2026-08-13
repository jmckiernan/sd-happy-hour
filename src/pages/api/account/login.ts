import type { APIRoute } from 'astro';
import { getUserByEmail, listSavedSpots, listAlerts } from '../../../lib/store';
import { publicUser, verifyPassword, cleanString } from '../../../lib/validation';
import { createSession } from '../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../lib/api';

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

  await createSession(cookies, user.id);
  const [savedSpots, alerts] = await Promise.all([listSavedSpots(user.id), listAlerts(user.id)]);
  return json(publicUser(user, savedSpots, alerts), 200);
};
