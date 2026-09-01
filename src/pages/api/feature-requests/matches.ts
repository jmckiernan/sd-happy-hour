import type { APIRoute } from 'astro';
import { getSession } from '../../../lib/session';
import { getUserById } from '../../../lib/store';
import { findFeatureMatches } from '../../../lib/feedbackStore';
import { errorJson, json } from '../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies }) => {
  const session = await getSession(cookies);
  const user = session ? await getUserById(session.userId) : null;
  if (!user) return errorJson(['Sign in to search feature requests.'], 401);
  const query = (url.searchParams.get('q') || '').trim().slice(0, 500);
  if (query.length < 4) return json({ matches: [] });
  return json({ matches: await findFeatureMatches(query, user.id) });
};
