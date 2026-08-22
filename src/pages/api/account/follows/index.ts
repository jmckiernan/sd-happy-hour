import type { APIRoute } from 'astro';
import { errorJson, json } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import { listAccountVenueFollows } from '../../../../lib/venueFollowService';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);
  return json(await listAccountVenueFollows(session.userId));
};
