import type { APIRoute } from 'astro';
import { errorJson, json } from '../../../../../lib/api';
import { getSignedInVenueOwner } from '../../../../../lib/venueUserAuthorization';
import { getVenueOwner, searchUsersForVenue } from '../../../../../lib/venueUsers';

export const prerender = false;

function maskEmail(email: string) {
  const [local, domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${local.length > 1 ? '***' : ''}@${domain}`;
}

export const GET: APIRoute = async ({ params, cookies, url }) => {
  const venueId = Number(params.id);
  if (!Number.isSafeInteger(venueId) || venueId <= 0) return errorJson(['Invalid venue id.'], 400);
  if (!await getSignedInVenueOwner(cookies, venueId)) return errorJson(['Only the restaurant owner can search for managing users.'], 403);

  const query = (url.searchParams.get('q') || '').trim();
  const isEmail = query.includes('@');
  if (isEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(query)) return json({ results: [], exactEmail: false });
  if (!isEmail && query.length < 3) return json({ results: [], exactEmail: false });

  const [users, owner] = await Promise.all([searchUsersForVenue(query), getVenueOwner(venueId)]);
  return json({
    exactEmail: isEmail,
    results: users
      .filter((user) => user.id !== owner?.user_id)
      .map((user) => ({
        id: user.id,
        name: user.name,
        email: isEmail ? user.email : maskEmail(user.email),
      })),
  });
};
