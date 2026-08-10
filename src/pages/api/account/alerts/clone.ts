import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { readUsers, writeUsers, publicUser, cleanAlertFilters, MAX_ALERTS_PER_USER, type Alert } from '../../../../lib/kv';
import { getSession } from '../../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../../lib/api';

export const prerender = false;

// "Add to my alerts" on /alerts/shared/ — copies someone else's shared
// alert into the signed-in user's own list. This is a one-time clone, not
// a live sync: editing the original afterward has no effect on the copy
// (see the alerts spec, "sharing" section) — kept simple deliberately,
// live-synced shared lists are a possible v2.
export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const shareId = String(body.shareId || '');
  const alertId = String(body.alertId || '');

  const users = await readUsers();
  const owner = users.find((item) => item.shareId === shareId);
  const sourceAlert = owner?.alerts?.find((item) => item.id === alertId);
  if (!owner || !sourceAlert) return errorJson(['Shared alert not found.'], 404);

  const user = users.find((item) => item.id === session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  user.alerts = user.alerts || [];
  if (user.alerts.length >= MAX_ALERTS_PER_USER) {
    return errorJson([`You can save up to ${MAX_ALERTS_PER_USER} alerts.`], 422);
  }
  if (user.alerts.some((item) => item.sourceAlertId === sourceAlert.id)) {
    return errorJson(['You already added this alert.'], 409);
  }

  const now = new Date().toISOString();
  const alert: Alert = {
    id: `alert_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`,
    name: sourceAlert.name,
    filters: cleanAlertFilters(sourceAlert.filters),
    // Cloned alerts always start email-only, regardless of the sharer's own
    // channel choices — text is opt-in per person, not something one user
    // can turn on for another.
    channels: { email: true, text: false },
    active: true,
    sourceAlertId: sourceAlert.id,
    createdAt: now,
    updatedAt: now,
  };
  user.alerts.unshift(alert);
  user.updatedAt = now;
  await writeUsers(users);
  return json(publicUser(user), 201);
};
