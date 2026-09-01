import type { APIRoute } from 'astro';
import { getSession } from '../../../lib/session';
import { getUserById } from '../../../lib/store';
import { createFeatureRequest, findFeatureMatches, listFeatureRequests } from '../../../lib/feedbackStore';
import { cleanString } from '../../../lib/validation';
import { errorJson, json, readJsonBody } from '../../../lib/api';

export const prerender = false;

async function signedInUser(cookies: Parameters<typeof getSession>[0]) {
  const session = await getSession(cookies);
  return session ? getUserById(session.userId) : null;
}

export const GET: APIRoute = async ({ cookies }) => {
  const user = await signedInUser(cookies);
  if (!user) return errorJson(['Sign in to view feature requests.'], 401);
  return json({ requests: await listFeatureRequests(user.id) });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const user = await signedInUser(cookies);
  if (!user) return errorJson(['Sign in to request a feature.'], 401);

  let body: Record<string, any>;
  try { body = await readJsonBody(request); }
  catch { return errorJson(['Invalid JSON body.'], 400); }

  const title = cleanString(body.title).slice(0, 120);
  const details = cleanString(body.details).slice(0, 2000);
  const errors: string[] = [];
  if (title.length < 5) errors.push('Feature title must be at least 5 characters.');
  if (errors.length) return errorJson(errors, 422);

  if (!body.confirmCreate) {
    const matches = await findFeatureMatches(`${title} ${details}`, user.id);
    if (matches.length) return json({ matches, needsConfirmation: true }, 409);
  }

  const featureRequest = await createFeatureRequest(user.id, title, details);
  return json({ request: featureRequest }, 201);
};
