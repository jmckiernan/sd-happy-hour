import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import { replaceListSubscription } from '../../../../lib/savedLists';

export const prerender = false;

export const PUT: APIRoute = async ({ params, cookies, request }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to manage list alerts.'], 401);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  try {
    const subscription = await replaceListSubscription(params.id!, session.userId, {
      happyHour: body.happyHour === true,
      liveDeals: body.liveDeals === true,
      email: body.email === true,
      text: body.text === true,
    });
    if (subscription === 'forbidden') return errorJson(['You do not have access to this list.'], 403);
    return json({ subscription });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not update list alerts.'], 422);
  }
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to manage list alerts.'], 401);
  const subscription = await replaceListSubscription(params.id!, session.userId, null);
  if (subscription === 'forbidden') return errorJson(['You do not have access to this list.'], 403);
  return json({ subscription: null });
};
