import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../../lib/api';
import { sendEmail } from '../../../../../lib/email';
import { getUserByEmail, getUserById } from '../../../../../lib/store';
import { getSignedInVenueOwner } from '../../../../../lib/venueUserAuthorization';
import {
  addVenueManager,
  createInviteToken,
  createVenueInvite,
  getVenueOwner,
  listPendingVenueInvites,
  listVenueManagers,
  removeVenueManager,
  revokeVenueInvite,
  revokePendingVenueInviteForEmail,
  updateVenueInviteRole,
  updateVenueManagerRole,
  type DelegatedVenueRole,
} from '../../../../../lib/venueUsers';
import { getVenueById } from '../../../../../lib/venues';

export const prerender = false;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function role(value: unknown): DelegatedVenueRole | null {
  return value === 'full_admin' || value === 'promotions' ? value : null;
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

async function authorize(params: Record<string, string | undefined>, cookies: Parameters<typeof getSignedInVenueOwner>[0]) {
  const venueId = Number(params.id);
  if (!Number.isSafeInteger(venueId) || venueId <= 0) return { response: errorJson(['Invalid venue id.'], 400) } as const;
  const owner = await getSignedInVenueOwner(cookies, venueId);
  if (!owner) return { response: errorJson(['Only the restaurant owner can manage users.'], 403) } as const;
  const venue = getVenueById(venueId);
  if (!venue) return { response: errorJson(['Venue not found.'], 404) } as const;
  return { venueId, owner, venue } as const;
}

export const GET: APIRoute = async ({ params, cookies }) => {
  const auth = await authorize(params, cookies);
  if ('response' in auth) return auth.response;
  const [owner, managers, invites] = await Promise.all([
    getVenueOwner(auth.venueId), listVenueManagers(auth.venueId), listPendingVenueInvites(auth.venueId),
  ]);
  return json({ owner, managers, invites });
};

export const POST: APIRoute = async ({ params, cookies, request, url }) => {
  const auth = await authorize(params, cookies);
  if ('response' in auth) return auth.response;
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); } catch { return errorJson(['Invalid JSON body.'], 400); }
  const selectedRole = role(body.role);
  if (!selectedRole) return errorJson(['Choose Full Admin or Promotions Only.'], 422);

  let target = typeof body.userId === 'string' ? await getUserById(body.userId) : null;
  const email = String(body.email || target?.email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) return errorJson(['Enter a complete, valid email address.'], 422);
  target ||= await getUserByEmail(email);
  if (target) {
    if (target.id === auth.owner.id) return errorJson(['The owner already has the highest access.'], 409);
    const manager = await addVenueManager(auth.venueId, target.id, selectedRole, auth.owner.id);
    await revokePendingVenueInviteForEmail(auth.venueId, target.email);
    return json({ kind: 'manager', manager }, 201);
  }

  const token = createInviteToken();
  const invite = await createVenueInvite(auth.venueId, email, selectedRole, auth.owner.id, token.hash);
  const invitationUrl = `${url.origin}/restaurant/invitations/${encodeURIComponent(token.token)}/`;
  const roleLabel = selectedRole === 'full_admin' ? 'Full Admin' : 'Promotions Only';
  let result;
  try {
    result = await sendEmail(
      email,
      `${auth.owner.name || auth.owner.email} invited you to manage ${auth.venue.name}`,
      `<p>${escapeHtml(auth.owner.name || auth.owner.email)} invited you to manage <strong>${escapeHtml(auth.venue.name)}</strong> on SD Happy Hours as <strong>${roleLabel}</strong>.</p><p><a href="${escapeHtml(invitationUrl)}">Accept invitation</a></p><p>This invitation expires in 7 days. You must sign in or create an account using ${escapeHtml(email)}.</p>`
    );
  } catch (error: any) {
    return errorJson([`The invitation was saved, but its email could not be sent: ${error.message}. Use Resend after checking the email configuration.`], 502);
  }
  return json({ kind: 'invite', invite, email: result }, 201);
};

export const PATCH: APIRoute = async ({ params, cookies, request }) => {
  const auth = await authorize(params, cookies);
  if ('response' in auth) return auth.response;
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); } catch { return errorJson(['Invalid JSON body.'], 400); }
  const selectedRole = role(body.role);
  const id = typeof body.id === 'string' ? body.id : '';
  if (!selectedRole || !id) return errorJson(['A user or invitation and role are required.'], 422);
  const updated = body.kind === 'invite'
    ? await updateVenueInviteRole(auth.venueId, id, selectedRole)
    : await updateVenueManagerRole(auth.venueId, id, selectedRole);
  return updated ? json({ updated }) : errorJson(['Managing user or invitation not found.'], 404);
};

export const DELETE: APIRoute = async ({ params, cookies, request }) => {
  const auth = await authorize(params, cookies);
  if ('response' in auth) return auth.response;
  let body: Record<string, unknown>;
  try { body = await readJsonBody(request); } catch { return errorJson(['Invalid JSON body.'], 400); }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return errorJson(['A user or invitation is required.'], 422);
  const removed = body.kind === 'invite'
    ? await revokeVenueInvite(auth.venueId, id)
    : await removeVenueManager(auth.venueId, id);
  return removed ? json({ removed: true }) : errorJson(['Managing user or invitation not found.'], 404);
};
