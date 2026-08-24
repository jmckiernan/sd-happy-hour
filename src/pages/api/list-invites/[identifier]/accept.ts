import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import { acceptHappyHourListInvite } from '../../../../lib/sharedLists';
import { getUserById } from '../../../../lib/store';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to accept this invitation.'], 401);
  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const result = await acceptHappyHourListInvite(params.identifier!, user, body.token);
  if (result === 'not_found') return errorJson(['This invitation is invalid, expired, or already used.'], 404);
  if (result === 'email_mismatch') return errorJson(['This invitation belongs to a different email address.'], 403);
  return json({ accepted: true, ...result });
};
