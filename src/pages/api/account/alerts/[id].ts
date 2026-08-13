import type { APIRoute } from 'astro';
import { getUserById, getAlert, updateAlert, deleteAlert, listSavedSpots, listAlerts } from '../../../../lib/store';
import { publicUser, cleanString, cleanAlertFilters, cleanAlertChannels } from '../../../../lib/validation';
import { getSession } from '../../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../../lib/api';

export const prerender = false;

// Partial update — rename, edit filters, change channels, or toggle
// active/inactive. Only fields present in the body are touched, so the
// on/off toggle in My Stuff (/account/) can PUT just `{ active }` without resending
// everything else.
export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  const existing = await getAlert(user.id, params.id!);
  if (!existing) return errorJson(['Alert not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  let name: string | undefined;
  if (body.name !== undefined) {
    name = cleanString(body.name).slice(0, 60);
    if (!name) return errorJson(['Alert name is required.'], 422);
  }

  const updated = await updateAlert(user.id, params.id!, {
    name,
    filters: body.filters !== undefined ? cleanAlertFilters(body.filters) : undefined,
    channels: body.channels !== undefined ? cleanAlertChannels(body.channels) : undefined,
    active: body.active !== undefined ? Boolean(body.active) : undefined,
  });
  if (!updated) return errorJson(['Alert not found.'], 404);

  const [savedSpots, alerts] = await Promise.all([listSavedSpots(user.id), listAlerts(user.id)]);
  return json(publicUser(user, savedSpots, alerts));
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  await deleteAlert(user.id, params.id!);
  const [savedSpots, alerts] = await Promise.all([listSavedSpots(user.id), listAlerts(user.id)]);
  return json(publicUser(user, savedSpots, alerts));
};
