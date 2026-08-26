import type { APIRoute } from 'astro';
import { getSession } from '../../../lib/session';
import { captureProductEvent } from '../../../lib/productAnalytics';
import { captureMerchantEvent, deviceTypeFromUserAgent } from '../../../lib/merchantAnalytics';
import { ensureMerchantAnalyticsIdentity } from '../../../lib/merchantAnalyticsIdentity';
import { marketAreaForCoordinates } from '../../../lib/marketAreas';
import { getVenues } from '../../../lib/venues';
import { getPromotionCampaignById } from '../../../lib/promotionRepo';
import { errorJson, json, readJsonBody } from '../../../lib/api';

export const prerender = false;

const LEGACY_PRODUCT_EVENTS = new Set(['venue_viewed', 'directions_opened']);
const MERCHANT_CLIENT_EVENTS = new Set([
  'venue_page_view',
  'website_click',
  'call_click',
  'directions_click',
  'share',
  'promotion_view',
  'promotion_click',
]);

const LEGACY_MERCHANT_EVENT: Record<string, 'venue_page_view' | 'directions_click'> = {
  venue_viewed: 'venue_page_view',
  directions_opened: 'directions_click',
};

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  const eventName = String(body.event || '');
  if (!LEGACY_PRODUCT_EVENTS.has(eventName) && !MERCHANT_CLIENT_EVENTS.has(eventName)) {
    return errorJson(['Unsupported client analytics event.'], 422);
  }
  const venueId = Number(body.venueId);
  const venue = getVenues().find((candidate) => candidate.id === venueId);
  if (!venue) return errorJson(['Venue not found.'], 404);
  const auth = await getSession(cookies);
  const identity = ensureMerchantAnalyticsIdentity(cookies, new URL(request.url).protocol === 'https:');
  const promotionId = typeof body.promotionId === 'string' && body.promotionId ? body.promotionId : null;
  if (promotionId) {
    const promotion = await getPromotionCampaignById(promotionId);
    if (!promotion || promotion.venueId !== venueId) return errorJson(['Promotion not found.'], 404);
  } else if (eventName === 'promotion_view' || eventName === 'promotion_click') {
    return errorJson(['Promotion id is required.'], 422);
  }
  if (LEGACY_PRODUCT_EVENTS.has(eventName)) {
    await captureProductEvent({
      eventName,
      userId: auth?.userId || null,
      sessionId: cookies.get('sdhh_activity_session')?.value || null,
      properties: {
        venue_id: venue.id,
        area_key: marketAreaForCoordinates(venue.lat, venue.lng),
      },
    });
  }
  await captureMerchantEvent({
    eventName: LEGACY_MERCHANT_EVENT[eventName] || eventName,
    venueId,
    promotionId,
    userId: auth?.userId || null,
    visitorId: identity.visitorId,
    visitId: identity.visitId,
    authenticated: Boolean(auth),
    source: typeof body.source === 'string' ? body.source : 'venue_page',
    deviceType: deviceTypeFromUserAgent(request.headers.get('user-agent')),
    properties: {
      referrer_host: typeof body.referrerHost === 'string' ? body.referrerHost : '',
    },
  });
  return json({ tracked: true });
};
