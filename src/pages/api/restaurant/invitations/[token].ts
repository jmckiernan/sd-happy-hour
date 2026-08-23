import type { APIRoute } from 'astro';
import { errorJson, json } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import { getUserById } from '../../../../lib/store';
import { acceptVenueInvite, getVenueInviteByToken } from '../../../../lib/venueUsers';
import { getVenueById, slugify } from '../../../../lib/venues';

export const prerender = false;

export const GET: APIRoute = async ({ params, cookies }) => {
  const invite = await getVenueInviteByToken(params.token || '');
  if (!invite) return errorJson(['Invitation not found.'], 404);
  const session = await getSession(cookies);
  const user = session ? await getUserById(session.userId) : null;
  const venue = getVenueById(invite.venueId);
  return json({
    invite: { email: invite.email, role: invite.role, expiresAt: invite.expiresAt, acceptedAt: invite.acceptedAt, revokedAt: invite.revokedAt },
    authenticated: Boolean(user),
    signedInEmail: user?.email || '',
    venue: venue ? { name: venue.name, slug: slugify(venue.name) } : null,
  });
};

export const POST: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in with the invited email first.'], 401);
  const user = await getUserById(session.userId);
  if (!user) return errorJson(['Account not found.'], 401);
  const result = await acceptVenueInvite(params.token || '', user.id, user.email);
  if (!result) return errorJson(['This invitation is invalid, expired, accepted, or revoked.'], 410);
  if (result.mismatch) return errorJson([`This invitation was sent to ${result.invite.email}. Sign in with that exact email.`], 403);
  const venue = getVenueById(result.invite.venueId);
  return json({ accepted: true, venueSlug: venue ? slugify(venue.name) : null });
};
