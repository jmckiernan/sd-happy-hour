import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { readUsers, writeUsers, publicUser, cleanString, cleanAlertFilters, cleanAlertChannels, MAX_ALERTS_PER_USER, type Alert } from '../../../../lib/kv';
import { getSession } from '../../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../../lib/api';

export const prerender = false;

// Creates a new saved alert (a named, saved filter combination) for the
// signed-in user — the "Save as Alert" action on the homepage, or the
// "Create new alert" form on /alerts/.
export const POST: APIRoute = async ({ request, cookies }) => {
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

  const name = cleanString(body.name).slice(0, 60);
  if (!name) return errorJson(['Alert name is required.'], 422);

  user.alerts = user.alerts || [];
  if (user.alerts.length >= MAX_ALERTS_PER_USER) {
    return errorJson([`You can save up to ${MAX_ALERTS_PER_USER} alerts.`], 422);
  }

  const now = new Date().toISOString();
  const alert: Alert = {
    id: `alert_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`,
    name,
    filters: cleanAlertFilters(body.filters || {}),
    channels: cleanAlertChannels(body.channels),
    active: true,
    createdAt: now,
    updatedAt: now,
  };

  user.alerts.unshift(alert);
  user.updatedAt = now;
  await writeUsers(users);
  return json(publicUser(user), 201);
};
