import type { APIRoute } from 'astro';
import {
  legacyPublicPromotionDto,
  listLegacyPublicPromotions,
} from '../../lib/legacyPromotionAdapter';
import { authenticationSensitivePromotionJson } from '../../lib/promotionDtos';
import { getDatabaseNow } from '../../lib/promotionRepo';
import { getSession } from '../../lib/session';

export const prerender = false;

// Public — every happy hour (including which ones have a promoted deal at
// all, and its public description) stays visible to anonymous visitors, as
// requested: only the deal *code* itself is gated. The gate is enforced
// here, server-side, by simply never including `dealCode` in the response
// unless the request carries a valid signed-in *user* session — not by
// sending the code to every client and hiding it with CSS, which anyone
// could inspect around.
export const GET: APIRoute = async ({ cookies }) => {
  const [serverNow, session] = await Promise.all([getDatabaseNow(), getSession(cookies)]);
  const promotions = await listLegacyPublicPromotions(serverNow);
  const signedIn = session?.role === 'user';

  const result: Record<number, { description: string; dealCode?: string }> = {};
  for (const [venueId, promotion] of Object.entries(promotions)) {
    result[Number(venueId)] = legacyPublicPromotionDto(promotion, signedIn);
  }
  return authenticationSensitivePromotionJson(result);
};
