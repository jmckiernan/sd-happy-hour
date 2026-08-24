import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../lib/api';
import { getSession } from '../../../lib/session';
import { getUnifiedSavedState, setDefaultListId } from '../../../lib/savedLists';

export const prerender = false;

export const PUT: APIRoute = async ({ cookies, request }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const listId = String(body.listId ?? '');
  if (!listId) return errorJson(['Choose a default list.'], 422);
  if (!await setDefaultListId(session.userId, listId)) {
    return errorJson(['Your default must be a list you can edit.'], 403);
  }
  return json({ saved: await getUnifiedSavedState(session.userId) });
};
