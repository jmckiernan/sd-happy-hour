import type { APIRoute } from 'astro';
import happyHours from '../../../../../public/data/happy-hours.json';
import { getSession } from '../../../../lib/session';
import { getUserById } from '../../../../lib/store';
import { createHappyHourList, listHappyHourListsForUser, MAX_CUSTOM_LISTS_PER_USER } from '../../../../lib/sharedLists';
import { errorJson, json, readJsonBody } from '../../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);
  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);
  return json(await listHappyHourListsForUser(user.id, user.email));
};

export const POST: APIRoute = async ({ cookies, request }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);
  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  try {
    const venueId = body.venueId === undefined || body.venueId === null
      ? null
      : Number(body.venueId);
    if (venueId !== null && !(happyHours as any[]).some((venue) => venue.id === venueId)) {
      return errorJson(['Venue not found.'], 404);
    }
    const list = await createHappyHourList(user.id, {
      title: body.title,
      description: body.description,
      ratingsEnabled: body.ratingsEnabled,
      commentsEnabled: body.commentsEnabled,
      venueId,
    });
    if (!list) {
      return errorJson([
        `You can create up to ${MAX_CUSTOM_LISTS_PER_USER} custom lists in addition to Favorites, Want to Try, and Been To.`,
      ], 409);
    }
    return json({ list }, 201);
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not create the list.'], 422);
  }
};
