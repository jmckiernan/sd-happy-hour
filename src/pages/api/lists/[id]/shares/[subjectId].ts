import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../../lib/api';
import { getSession } from '../../../../../lib/session';
import { removeHappyHourListAccess, updateHappyHourListAccess } from '../../../../../lib/sharedLists';

export const prerender = false;

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to manage access.'], 401);
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  try {
    const updated = await updateHappyHourListAccess(params.id!, session.userId, params.subjectId!, body.role);
    if (!updated) return errorJson(['Only the owner can update access.'], 403);
    return json({ updated: true });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not update access.'], 422);
  }
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to manage access.'], 401);
  const removed = await removeHappyHourListAccess(params.id!, session.userId, params.subjectId!);
  if (!removed) return errorJson(['Only the owner can remove access.'], 403);
  return json({ removed: true });
};
