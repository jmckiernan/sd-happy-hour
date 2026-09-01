import type { APIRoute } from 'astro';
import { getSession } from '../../../../lib/session';
import { getUserById } from '../../../../lib/store';
import { upvoteFeatureRequest } from '../../../../lib/feedbackStore';
import { errorJson, json } from '../../../../lib/api';

export const prerender = false;

export const POST: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  const user = session ? await getUserById(session.userId) : null;
  if (!user) return errorJson(['Sign in to upvote feature requests.'], 401);
  const id = params.id || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return errorJson(['Invalid feature request id.'], 400);
  }
  const result = await upvoteFeatureRequest(id, user.id);
  if (result.status === 'not_found') return errorJson(['Feature request not found.'], 404);
  return json(result, result.status === 'created' ? 201 : 200);
};
