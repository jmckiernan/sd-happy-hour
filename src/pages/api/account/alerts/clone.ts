import type { APIRoute } from 'astro';
import { getUserById, getUserByShareId, getAlert, createAlert, hasAlertWithSource, listSavedSpots, listAlerts, MAX_ALERTS_PER_USER } from '../../../../lib/store';
import { publicUser } from '../../../../lib/validation';
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

  const owner = await getUserByShareId(shareId);
  const sourceAlert = owner ? await getAlert(owner.id, alertId) : null;
  if (!owner || !sourceAlert) return errorJson(['Shared alert not found.'], 404);

  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  if (await hasAlertWithSource(user.id, sourceAlert.id)) {
    return errorJson(['You already added this alert.'], 409);
  }

  const alert = await createAlert(user.id, {
    name: sourceAlert.name,
    filters: sourceAlert.filters,
    // Cloned alerts always start email-only, regardless of the sharer's own
    // channel choices — text is opt-in per person, not something one user
    // can turn on for another.
    channels: { email: true, text: false },
    sourceAlertId: sourceAlert.id,
  });
  if (!alert) return errorJson([`You can save up to ${MAX_ALERTS_PER_USER} alerts.`], 422);

  const [savedSpots, alerts] = await Promise.all([listSavedSpots(user.id), listAlerts(user.id)]);
  return json(publicUser(user, savedSpots, alerts), 201);
};
