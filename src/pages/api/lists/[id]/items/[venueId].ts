import type { APIRoute } from 'astro';
import happyHours from '../../../../../../public/data/happy-hours.json';
import { errorJson, json } from '../../../../../lib/api';
import { getSession } from '../../../../../lib/session';
import {
  addVenueToHappyHourList,
  MAX_VENUES_PER_LIST,
  removeVenueFromHappyHourList,
} from '../../../../../lib/sharedLists';
import { captureMerchantEvent, deviceTypeFromUserAgent } from '../../../../../lib/merchantAnalytics';
import { ensureMerchantAnalyticsIdentity } from '../../../../../lib/merchantAnalyticsIdentity';
import { captureProductEvent } from '../../../../../lib/productAnalytics';

export const prerender = false;

function validVenueId(raw: string | undefined): number | null {
  const venueId = Number(raw);
  return Number.isInteger(venueId) && (happyHours as any[]).some((venue) => venue.id === venueId)
    ? venueId
    : null;
}

export const PUT: APIRoute = async ({ params, cookies, request }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to add venues.'], 401);
  const venueId = validVenueId(params.venueId);
  if (!venueId) return errorJson(['Venue not found.'], 404);
  const result = await addVenueToHappyHourList(params.id!, session.userId, venueId);
  if (result === 'forbidden') return errorJson(['You do not have permission to edit this list.'], 403);
  if (result === 'full') return errorJson([`A list can contain up to ${MAX_VENUES_PER_LIST} venues.`], 409);
  if (result === 'added') {
    const identity = ensureMerchantAnalyticsIdentity(cookies, new URL(request.url).protocol === 'https:');
    await Promise.all([
      captureProductEvent({ eventName: 'list_venue_added', userId: session.userId, properties: { venue_id: venueId, list_type: 'saved_list' } }),
      captureMerchantEvent({
        eventName: 'save', venueId, userId: session.userId, visitorId: identity.visitorId,
        visitId: identity.visitId, authenticated: true, source: 'saved_list',
        deviceType: deviceTypeFromUserAgent(request.headers.get('user-agent')),
      }),
    ]);
  }
  return json({ status: result, venueId });
};

export const DELETE: APIRoute = async ({ params, cookies, request }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to remove venues.'], 401);
  const venueId = validVenueId(params.venueId);
  if (!venueId) return errorJson(['Venue not found.'], 404);
  const result = await removeVenueFromHappyHourList(params.id!, session.userId, venueId);
  if (result === 'forbidden') return errorJson(['You do not have permission to edit this list.'], 403);
  if (result === 'removed') {
    const identity = ensureMerchantAnalyticsIdentity(cookies, new URL(request.url).protocol === 'https:');
    await captureMerchantEvent({
      eventName: 'unsave', venueId, userId: session.userId, visitorId: identity.visitorId,
      visitId: identity.visitId, authenticated: true, source: 'saved_list',
      deviceType: deviceTypeFromUserAgent(request.headers.get('user-agent')),
    });
  }
  return json({ status: result, venueId });
};
