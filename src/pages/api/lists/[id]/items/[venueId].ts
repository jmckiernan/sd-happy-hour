import type { APIRoute } from 'astro';
import happyHours from '../../../../../../public/data/happy-hours.json';
import { errorJson, json } from '../../../../../lib/api';
import { getSession } from '../../../../../lib/session';
import {
  addVenueToHappyHourList,
  MAX_VENUES_PER_LIST,
  removeVenueFromHappyHourList,
} from '../../../../../lib/sharedLists';

export const prerender = false;

function validVenueId(raw: string | undefined): number | null {
  const venueId = Number(raw);
  return Number.isInteger(venueId) && (happyHours as any[]).some((venue) => venue.id === venueId)
    ? venueId
    : null;
}

export const PUT: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to add venues.'], 401);
  const venueId = validVenueId(params.venueId);
  if (!venueId) return errorJson(['Venue not found.'], 404);
  const result = await addVenueToHappyHourList(params.id!, session.userId, venueId);
  if (result === 'forbidden') return errorJson(['You do not have permission to edit this list.'], 403);
  if (result === 'full') return errorJson([`A list can contain up to ${MAX_VENUES_PER_LIST} venues.`], 409);
  return json({ status: result, venueId });
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to remove venues.'], 401);
  const venueId = validVenueId(params.venueId);
  if (!venueId) return errorJson(['Venue not found.'], 404);
  const result = await removeVenueFromHappyHourList(params.id!, session.userId, venueId);
  if (result === 'forbidden') return errorJson(['You do not have permission to edit this list.'], 403);
  return json({ status: result, venueId });
};

