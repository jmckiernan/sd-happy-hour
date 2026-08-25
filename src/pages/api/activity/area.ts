import type { APIRoute } from 'astro';
import { getSession } from '../../../lib/session';
import { captureProductEvent, recordNearMeArea } from '../../../lib/productAnalytics';
import { marketAreaForCoordinates, marketAreaLabel } from '../../../lib/marketAreas';
import { errorJson, json, readJsonBody } from '../../../lib/api';

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return errorJson(['A valid location is required.'], 422);
  }
  if (body.consent !== true) return errorJson(['Location analytics consent is required.'], 422);

  const auth = await getSession(cookies);
  if (!auth) {
    const areaKey = marketAreaForCoordinates(latitude, longitude);
    return json({ stored: false, areaKey, areaLabel: marketAreaLabel(areaKey) });
  }

  const area = await recordNearMeArea(auth.userId, latitude, longitude);
  await captureProductEvent({
    eventName: 'near_me_used',
    userId: auth.userId,
    sessionId: cookies.get('sdhh_activity_session')?.value || null,
    properties: { area_key: area.areaKey },
  });
  return json({ stored: true, ...area });
};

