import type { APIRoute } from 'astro';
import happyHours from '../../../../../../../public/data/happy-hours.json';
import { errorJson, json, readJsonBody } from '../../../../../../lib/api';
import { getSession } from '../../../../../../lib/session';
import { replaceVenueFeedback } from '../../../../../../lib/savedLists';

export const prerender = false;

function validVenueId(raw: string | undefined): number | null {
  const venueId = Number(raw);
  return Number.isInteger(venueId) && (happyHours as any[]).some((venue) => venue.id === venueId)
    ? venueId
    : null;
}

/** Saves global rating/comment plus optional list-scoped note for this membership. */
export const PUT: APIRoute = async ({ params, cookies, request }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to add notes.'], 401);
  const venueId = validVenueId(params.venueId);
  if (!venueId) return errorJson(['Venue not found.'], 404);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  try {
    const payload: { rating?: unknown; comment?: unknown; note?: unknown } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'rating')) payload.rating = body.rating;
    if (Object.prototype.hasOwnProperty.call(body, 'comment')) payload.comment = body.comment;
    if (Object.prototype.hasOwnProperty.call(body, 'note')) payload.note = body.note;
    const status = await replaceVenueFeedback(params.id!, venueId, session.userId, payload);
    if (status === 'forbidden') return errorJson(['You cannot edit this list.'], 403);
    if (status === 'missing') return errorJson(['This venue is not on the list.'], 404);
    return json({ status });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not save notes.'], 422);
  }
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to remove notes.'], 401);
  const venueId = validVenueId(params.venueId);
  if (!venueId) return errorJson(['Venue not found.'], 404);
  const status = await replaceVenueFeedback(params.id!, venueId, session.userId, {
    rating: null,
    comment: '',
    note: '',
    clear: true,
  });
  if (status === 'forbidden') return errorJson(['You cannot edit this list.'], 403);
  if (status === 'missing') return errorJson(['This venue is not on the list.'], 404);
  return json({ status });
};
