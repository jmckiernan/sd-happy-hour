import type { APIRoute } from 'astro';
import { readUsers, writeUsers, publicUser, cleanString, cleanAlertFilters, cleanAlertChannels } from '../../../../lib/kv';
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

  const users = await readUsers();
  const user = users.find((item) => item.id === session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  user.alerts = user.alerts || [];
  const alert = user.alerts.find((item) => item.id === params.id);
  if (!alert) return errorJson(['Alert not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  if (body.name !== undefined) {
    const name = cleanString(body.name).slice(0, 60);
    if (!name) return errorJson(['Alert name is required.'], 422);
    alert.name = name;
  }
  if (body.filters !== undefined) alert.filters = cleanAlertFilters(body.filters);
  if (body.channels !== undefined) alert.channels = cleanAlertChannels(body.channels);
  if (body.active !== undefined) alert.active = Boolean(body.active);

  alert.updatedAt = new Date().toISOString();
  user.updatedAt = alert.updatedAt;
  await writeUsers(users);
  return json(publicUser(user));
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  const users = await readUsers();
  const user = users.find((item) => item.id === session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  user.alerts = (user.alerts || []).filter((item) => item.id !== params.id);
  user.updatedAt = new Date().toISOString();
  await writeUsers(users);
  return json(publicUser(user));
};
