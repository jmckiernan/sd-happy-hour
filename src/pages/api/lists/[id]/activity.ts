import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import { getHappyHourListForViewer, recordHappyHourListActivity } from '../../../../lib/sharedLists';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);
  const list = await getHappyHourListForViewer(params.id!, session.userId);
  if (!list?.access.isMember) return errorJson(['You do not have access to this list.'], 403);
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  if (body.event !== 'share_link_copied') return errorJson(['Unsupported event.'], 422);
  await recordHappyHourListActivity(list.id, session.userId, 'share_link_copied', {
    role: body.role === 'editor' ? 'editor' : 'viewer',
  });
  return json({ tracked: true });
};
