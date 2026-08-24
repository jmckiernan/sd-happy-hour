import type { APIRoute } from 'astro';
import happyHours from '../../../../../public/data/happy-hours.json';
import { errorJson, json } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import {
  addVenueToDefaultList,
  getDefaultListId,
  getUnifiedSavedState,
  MAX_VENUES_PER_SAVED_LIST,
} from '../../../../lib/savedLists';
import { removeVenueFromHappyHourList } from '../../../../lib/sharedLists';

export const prerender = false;

export const POST: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);
  const venueId = Number(params.venueId);
  if (!Number.isInteger(venueId) || !(happyHours as any[]).some((venue) => venue.id === venueId)) {
    return errorJson(['Venue not found.'], 404);
  }
  const result = await addVenueToDefaultList(session.userId, venueId);
  if (result.status === 'full') {
    return errorJson([`A list can contain up to ${MAX_VENUES_PER_SAVED_LIST} venues.`], 409);
  }
  return json({ ...result, saved: await getUnifiedSavedState(session.userId) });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);
  const venueId = Number(params.venueId);
  if (!Number.isInteger(venueId) || !(happyHours as any[]).some((venue) => venue.id === venueId)) {
    return errorJson(['Venue not found.'], 404);
  }
  const listId = await getDefaultListId(session.userId);
  const status = await removeVenueFromHappyHourList(listId, session.userId, venueId);
  if (status === 'forbidden') return errorJson(['Could not edit the default list.'], 403);
  return json({ listId, status, saved: await getUnifiedSavedState(session.userId) });
};
