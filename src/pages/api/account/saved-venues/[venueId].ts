import type { APIRoute } from 'astro';
import happyHours from '../../../../../public/data/happy-hours.json';
import { errorJson, json } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import {
  addVenueToDefaultList,
  getDefaultListId,
  getUnifiedSavedState,
  MAX_VENUES_PER_SAVED_LIST,
} from '../../../../lib/savedLists';
import { removeVenueFromHappyHourList } from '../../../../lib/sharedLists';
import { captureProductEvent } from '../../../../lib/productAnalytics';
import { captureMerchantEvent, deviceTypeFromUserAgent } from '../../../../lib/merchantAnalytics';
import { ensureMerchantAnalyticsIdentity } from '../../../../lib/merchantAnalyticsIdentity';

export const prerender = false;

export const POST: APIRoute = async ({ params, cookies, request }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);
  const venueId = Number(params.venueId);
  if (!Number.isInteger(venueId) || !(happyHours as any[]).some((venue) => venue.id === venueId)) {
    return errorJson(['Venue not found.'], 404);
  }
  const result = await addVenueToDefaultList(session.userId, venueId);
  if (result.status === 'full') {
    return errorJson([`A list can contain up to ${MAX_VENUES_PER_SAVED_LIST} venues.`], 409);
  }
  if (result.status === 'added') {
    const identity = ensureMerchantAnalyticsIdentity(cookies, new URL(request.url).protocol === 'https:');
    await captureProductEvent({
      eventName: 'venue_saved', userId: session.userId,
      properties: { venue_id: venueId, list_type: 'default' },
    });
    await captureMerchantEvent({
      eventName: 'save', venueId, userId: session.userId,
      visitorId: identity.visitorId, visitId: identity.visitId, authenticated: true,
      source: 'venue_page', deviceType: deviceTypeFromUserAgent(request.headers.get('user-agent')),
    });
  }
  return json({ ...result, saved: await getUnifiedSavedState(session.userId) });
};

export const DELETE: APIRoute = async ({ params, cookies, request }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);
  const venueId = Number(params.venueId);
  if (!Number.isInteger(venueId) || !(happyHours as any[]).some((venue) => venue.id === venueId)) {
    return errorJson(['Venue not found.'], 404);
  }
  const listId = await getDefaultListId(session.userId);
  const status = await removeVenueFromHappyHourList(listId, session.userId, venueId);
  if (status === 'forbidden') return errorJson(['Could not edit the default list.'], 403);
  if (status === 'removed') {
    const identity = ensureMerchantAnalyticsIdentity(cookies, new URL(request.url).protocol === 'https:');
    await captureProductEvent({
      eventName: 'venue_unsaved', userId: session.userId,
      properties: { venue_id: venueId, list_type: 'default' },
    });
    await captureMerchantEvent({
      eventName: 'unsave', venueId, userId: session.userId,
      visitorId: identity.visitorId, visitId: identity.visitId, authenticated: true,
      source: 'venue_page', deviceType: deviceTypeFromUserAgent(request.headers.get('user-agent')),
    });
  }
  return json({ listId, status, saved: await getUnifiedSavedState(session.userId) });
};
