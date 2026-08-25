import type { APIRoute } from 'astro';
import { getSession } from '../../../lib/session';
import { captureProductEvent } from '../../../lib/productAnalytics';
import { marketAreaForCoordinates } from '../../../lib/marketAreas';
import { getVenues } from '../../../lib/venues';
import { errorJson, json, readJsonBody } from '../../../lib/api';

export const prerender = false;

const CLIENT_EVENTS = new Set(['venue_viewed', 'directions_opened']);

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const eventName = String(body.event || '');
  if (!CLIENT_EVENTS.has(eventName)) return errorJson(['Unsupported client analytics event.'], 422);
  const venueId = Number(body.venueId);
  const venue = getVenues().find((candidate) => candidate.id === venueId);
  if (!venue) return errorJson(['Venue not found.'], 404);
  const auth = await getSession(cookies);
  await captureProductEvent({
    eventName,
    userId: auth?.userId || null,
    sessionId: cookies.get('sdhh_activity_session')?.value || null,
    properties: {
      venue_id: venue.id,
      area_key: marketAreaForCoordinates(venue.lat, venue.lng),
    },
  });
  return json({ tracked: true });
};

