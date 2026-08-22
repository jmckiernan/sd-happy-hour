import type { APIRoute } from 'astro';
import { getUserById, createAlert, listSavedSpots, listAlerts, MAX_ALERTS_PER_USER } from '../../../../lib/store';
import {
  publicUser,
  cleanString,
  cleanAlertFilters,
  cleanAlertChannels,
  validateAlertKinds,
} from '../../../../lib/validation';
import { getSession } from '../../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../../lib/api';

export const prerender = false;

// Creates a new saved alert (a named, saved filter combination) for the
// signed-in user — the "Save as Alert" action on the homepage, or the
// "Create new alert" form in the Alerts section of My Stuff (/account/).
export const POST: APIRoute = async ({ request, cookies }) => {
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

  const name = cleanString(body.name).slice(0, 60);
  if (!name) return errorJson(['Alert name is required.'], 422);
  const { alertKinds, errors: alertKindErrors } = validateAlertKinds(body.alertKinds);
  if (alertKindErrors.length) return errorJson(alertKindErrors, 422);

  // The 25-alert cap is enforced inside the insert itself now (README-NEON-
  // MIGRATION.md §4), so a null result unambiguously means "cap hit" rather
  // than racing a separate count-then-insert.
  const alert = await createAlert(user.id, {
    name,
    filters: cleanAlertFilters(body.filters || {}),
    channels: cleanAlertChannels(body.channels),
    alertKinds,
  });
  if (!alert) return errorJson([`You can save up to ${MAX_ALERTS_PER_USER} alerts.`], 422);

  const [savedSpots, alerts] = await Promise.all([listSavedSpots(user.id), listAlerts(user.id)]);
  return json(publicUser(user, savedSpots, alerts), 201);
};
