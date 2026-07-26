import type { APIRoute } from 'astro';
import { readUsers, writeUsers, publicUser, cleanString } from '../../../../lib/kv';
import { getSession } from '../../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../../lib/api';
import happyHours from '../../../../../public/data/happy-hours.json';

export const prerender = false;

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  const users = await readUsers();
  const user = users.find((item) => item.id === session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  const spotId = Number(params.id);
  if (!(happyHours as any[]).some((spot) => spot.id === spotId)) {
    return errorJson(['Spot not found.'], 404);
  }

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const status = cleanString(body.status || 'favorite');
  if (!['favorite', 'want-to-try', 'been-to'].includes(status)) {
    return errorJson(['Status must be favorite, want-to-try, or been-to.'], 422);
  }

  const note = cleanString(body.note).slice(0, 500);
  const now = new Date().toISOString();
  user.savedSpots = user.savedSpots || [];
  const existing = user.savedSpots.find((item) => item.spotId === spotId);
  if (existing) {
    existing.status = status as any;
    existing.note = note;
    existing.updatedAt = now;
  } else {
    user.savedSpots.unshift({ spotId, status: status as any, note, createdAt: now, updatedAt: now });
  }
  user.updatedAt = now;
  await writeUsers(users);
  return json(publicUser(user));
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  const users = await readUsers();
  const user = users.find((item) => item.id === session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  const spotId = Number(params.id);
  user.savedSpots = (user.savedSpots || []).filter((item) => item.spotId !== spotId);
  user.updatedAt = new Date().toISOString();
  await writeUsers(users);
  return json(publicUser(user));
};
