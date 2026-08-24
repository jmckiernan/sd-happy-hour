import type { APIRoute } from 'astro';
import { getUserById, listAlerts } from '../../../../lib/store';
import { addVenueToHappyHourList } from '../../../../lib/sharedLists';
import {
  getUnifiedSavedState,
  projectLegacySavedSpots,
  replaceVenueFeedback,
} from '../../../../lib/savedLists';
import { publicUser, cleanString } from '../../../../lib/validation';
import { getSession } from '../../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../../lib/api';
import happyHours from '../../../../../public/data/happy-hours.json';

export const prerender = false;

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  const user = await getUserById(session.userId);
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

  const saved = await getUnifiedSavedState(user.id);
  const systemKey = status === 'favorite'
    ? 'favorites'
    : status === 'want-to-try'
      ? 'want_to_try'
      : 'been_to';
  const target = saved.lists.find((list) => list.systemKey === systemKey && list.role === 'owner');
  if (!target) return errorJson(['Built-in list not found.'], 409);
  const result = await addVenueToHappyHourList(target.id, user.id, spotId);
  if (result === 'forbidden') return errorJson(['Could not edit the built-in list.'], 403);
  if (result === 'full') return errorJson(['The selected list is full.'], 409);
  if (note || rating) {
    await replaceVenueFeedback(target.id, spotId, user.id, { comment: note, rating });
  }
  const [nextSaved, alerts] = await Promise.all([getUnifiedSavedState(user.id), listAlerts(user.id)]);
  return json(publicUser(user, projectLegacySavedSpots(nextSaved), alerts, nextSaved));
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  return errorJson([
    'Saved venues can belong to several lists. Remove the venue from the specific list instead.',
  ], 409);
};
