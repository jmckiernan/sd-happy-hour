import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../../lib/api';
import { getAdminUser } from '../../../../../lib/admins';
import { getUserByEmail } from '../../../../../lib/store';
import { getVenueOwner, transferVenueOwner } from '../../../../../lib/venueUsers';
import { getVenueById } from '../../../../../lib/venues';

export const prerender = false;

function venueId(raw: string | undefined) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export const GET: APIRoute = async ({ params, cookies }) => {
  if (!await getAdminUser(cookies)) return errorJson(['Super-admin access required.'], 403);
  const id = venueId(params.id);
  if (!id || !getVenueById(id)) return errorJson(['Venue not found.'], 404);
  return json({ owner: await getVenueOwner(id) });
};

export const POST: APIRoute = async ({ params, cookies, request }) => {
  if (!await getAdminUser(cookies)) return errorJson(['Super-admin access required.'], 403);
  const id = venueId(params.id);
  if (!id || !getVenueById(id)) return errorJson(['Venue not found.'], 404);
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); } catch { return errorJson(['Invalid JSON body.'], 400); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return errorJson(['Enter the new owner’s complete email.'], 422);
  const user = await getUserByEmail(email);
  if (!user) return errorJson(['That email does not have an Happy Hour SD account yet.'], 404);
  const transferred = await transferVenueOwner(id, user.id);
  if (!transferred) return errorJson(['This venue does not have a verified owner to transfer.'], 409);
  return json({ owner: await getVenueOwner(id) });
};
