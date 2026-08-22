import type { APIRoute } from 'astro';
import { errorJson } from '../../../lib/api';
import {
  authenticationSensitivePromotionJson,
  toPublicPromotionDto,
} from '../../../lib/promotionDtos';
import { getDatabaseNow, listLivePromotionCampaigns } from '../../../lib/promotionRepo';
import { getSession } from '../../../lib/session';
import { getMergedVenues } from '../../../lib/venueContent';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies }) => {
  const rawVenueId = url.searchParams.get('venueId');
  let venueId: number | undefined;
  if (rawVenueId !== null) {
    venueId = Number(rawVenueId);
    if (!Number.isSafeInteger(venueId) || venueId <= 0) {
      return errorJson(['Invalid venue id.'], 400);
    }
  }

  const [serverNow, session, venues] = await Promise.all([
    getDatabaseNow(),
    getSession(cookies),
    getMergedVenues(),
  ]);
  const venueById = new Map(venues.map((venue) => [venue.id, venue]));
  if (venueId !== undefined && !venueById.has(venueId)) {
    return errorJson(['Venue not found.'], 404);
  }

  const promotions = await listLivePromotionCampaigns(serverNow, venueId);
  const signedIn = session?.role === 'user';
  return authenticationSensitivePromotionJson({
    serverNow,
    promotions: promotions.flatMap((promotion) => {
      const venue = venueById.get(promotion.venueId);
      return venue ? [toPublicPromotionDto(promotion, venue, serverNow, signedIn)] : [];
    }),
  });
};
