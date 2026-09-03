import type { APIRoute } from 'astro';
import { getAdminUser } from '../../../../lib/admins';
import {
  isFeatureRequestStatus,
  updateFeatureRequestStatus,
} from '../../../../lib/feedbackStore';
import { errorJson, json, readJsonBody } from '../../../../lib/api';

export const prerender = false;

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  if (!await getAdminUser(cookies)) {
    return errorJson(['Admin sign-in required.'], 403);
  }

  const id = params.id || '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return errorJson(['Invalid feature request id.'], 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  if (!isFeatureRequestStatus(body.status)) {
    return errorJson(['Status must be open, planned, complete, or closed.'], 422);
  }

  const featureRequest = await updateFeatureRequestStatus(id, body.status);
  if (!featureRequest) return errorJson(['Feature request not found.'], 404);
  return json({ request: featureRequest });
};
