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

  // Rating only makes sense for spots you've actually favorited or been
  // to — not ones still on the "want to try" list. Rather than error out
  // if a stale rating value tags along with a status change (e.g. moving
  // a rated favorite back to "want to try"), it's just silently dropped so
  // status is always the source of truth for whether a rating is kept.
  let rating: number | undefined;
  if (status === 'favorite' || status === 'been-to') {
    if (body.rating !== undefined && body.rating !== null && body.rating !== '') {
      const parsed = Number(body.rating);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
        return errorJson(['Rating must be a whole number from 1 to 5.'], 422);
      }
      rating = parsed;
    }
  }

  const now = new Date().toISOString();
  user.savedSpots = user.savedSpots || [];
  const existing = user.savedSpots.find((item) => item.spotId === spotId);
  if (existing) {
    existing.status = status as any;
    existing.note = note;
    existing.rating = rating;
    existing.updatedAt = now;
  } else {
    user.savedSpots.unshift({ spotId, status: status as any, note, rating, createdAt: now, updatedAt: now });
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
