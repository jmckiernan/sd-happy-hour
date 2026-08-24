import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../../lib/api';
import { sendEmail } from '../../../../../lib/email';
import { getSession } from '../../../../../lib/session';
import { getUserById } from '../../../../../lib/store';
import {
  createHappyHourListInvite,
  getHappyHourListForViewer,
  listHappyHourListAccess,
} from '../../../../../lib/sharedLists';

export const prerender = false;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

export const GET: APIRoute = async ({ params, cookies, request }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to see who has access.'], 401);
  const access = await listHappyHourListAccess(params.id!, session.userId);
  if (!access) return errorJson(['You do not have access to this list.'], 403);
  const list = await getHappyHourListForViewer(params.id!, session.userId);
  return json({
    access: access.map((entry) => ({
      ...entry,
      inviteUrl: list?.canManageSharing && entry.isLinkInvite
        ? new URL(`/lists/${encodeURIComponent(params.id!)}/?invite=${encodeURIComponent(entry.id)}`, request.url).toString()
        : null,
    })),
  });
};

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to share this list.'], 401);
  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  try {
    const invite = await createHappyHourListInvite(params.id!, user.id, body);
    if (!invite) return errorJson(['Only the owner can invite people to this list.'], 403);
    const list = await getHappyHourListForViewer(params.id!, user.id);
    const inviteCredential = invite.email ? invite.rawToken : invite.id;
    const inviteUrl = new URL(`/lists/${encodeURIComponent(params.id!)}/?invite=${encodeURIComponent(inviteCredential)}`, request.url).toString();
    let delivery = null;
    if (invite.email) {
      try {
        delivery = await sendEmail(
          invite.email,
          `${user.name || 'A friend'} shared “${list?.title || 'a happy hour list'}” with you`,
          `<p>${escapeHtml(user.name || user.email)} invited you to ${invite.role === 'editor' ? 'collaborate on' : 'view'} <strong>${escapeHtml(list?.title || 'a happy hour list')}</strong>.</p><p><a href="${escapeHtml(inviteUrl)}">Open the live list</a></p>`
        );
      } catch (error) {
        console.error('[list invite email]', error instanceof Error ? error.message : error);
        delivery = { sent: false, simulated: false };
      }
    }
    return json({
      invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
      inviteUrl,
      delivery,
    }, 201);
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not share the list.'], 422);
  }
};
