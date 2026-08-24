import type { APIRoute } from 'astro';
import { errorJson, json } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import { getUnifiedSavedState } from '../../../../lib/savedLists';

export const prerender = false;

export const GET: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);
  return json({ saved: await getUnifiedSavedState(session.userId) });
};
