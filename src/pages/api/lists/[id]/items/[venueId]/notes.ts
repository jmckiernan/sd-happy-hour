import type { APIRoute } from 'astro';
import happyHours from '../../../../../../../public/data/happy-hours.json';
import { errorJson, json, readJsonBody } from '../../../../../../lib/api';
import { getSession } from '../../../../../../lib/session';
import { replaceListItemNote } from '../../../../../../lib/savedLists';

export const prerender = false;

function validVenueId(raw: string | undefined): number | null {
  const venueId = Number(raw);
  return Number.isInteger(venueId) && (happyHours as any[]).some((venue) => venue.id === venueId)
    ? venueId
    : null;
}

export const PUT: APIRoute = async ({ params, cookies, request }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to save a list note.'], 401);
  const venueId = validVenueId(params.venueId);
  if (!venueId) return errorJson(['Venue not found.'], 404);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  try {
    const status = await replaceListItemNote(params.id!, venueId, session.userId, {
      note: body.note,
    });
    if (status === 'forbidden') return errorJson(['You cannot edit this list.'], 403);
    if (status === 'missing') return errorJson(['This venue is not on the list.'], 404);
    return json({ status });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not save the note.'], 422);
  }
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to remove a list note.'], 401);
  const venueId = validVenueId(params.venueId);
  if (!venueId) return errorJson(['Venue not found.'], 404);
  const status = await replaceListItemNote(params.id!, venueId, session.userId, {
    note: '',
    clear: true,
  });
  if (status === 'forbidden') return errorJson(['You cannot edit this list.'], 403);
  if (status === 'missing') return errorJson(['This venue is not on the list.'], 404);
  return json({ status });
};
