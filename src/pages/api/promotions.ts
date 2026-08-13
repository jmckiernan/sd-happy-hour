import type { APIRoute } from 'astro';
import { getPromotions } from '../../lib/store';
import { getSession } from '../../lib/session';
import { json } from '../../lib/api';

export const prerender = false;

// Public — every happy hour (including which ones have a promoted deal at
// all, and its public description) stays visible to anonymous visitors, as
// requested: only the deal *code* itself is gated. The gate is enforced
// here, server-side, by simply never including `dealCode` in the response
// unless the request carries a valid signed-in *user* session — not by
// sending the code to every client and hiding it with CSS, which anyone
// could inspect around.
export const GET: APIRoute = async ({ cookies }) => {
  const [promotions, session] = await Promise.all([getPromotions(), getSession(cookies)]);
  const signedIn = session?.role === 'user';

  const result: Record<number, { description: string; dealCode?: string }> = {};
  for (const [venueId, promo] of Object.entries(promotions)) {
    result[Number(venueId)] = signedIn
      ? { description: promo.description, dealCode: promo.dealCode }
      : { description: promo.description };
  }
  return json(result);
};
