import type { APIRoute } from 'astro';
import happyHours from '../../../../../public/data/happy-hours.json';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import {
  deleteHappyHourList,
  getHappyHourListForViewer,
  recordHappyHourListActivity,
  updateHappyHourList,
} from '../../../../lib/sharedLists';
import { venueSlug } from '../../../../lib/venues';

export const prerender = false;

export const GET: APIRoute = async ({ params, url, cookies }) => {
  const session = await getSession(cookies);
  const inviteToken = url.searchParams.get('invite');
  const list = await getHappyHourListForViewer(params.id!, session?.userId ?? null, inviteToken);
  // Not-found for both missing and unauthorized prevents private-list ID probing.
  if (!list) return errorJson(['List not found or this share link is no longer active.'], 404);

  if (url.searchParams.get('track') === '1') {
    await recordHappyHourListActivity(list.id, session?.userId ?? null, 'shared_list_viewed', {
      accessMethod: inviteToken ? 'invite_link' : list.role,
    });
  }

  const venuesById = new Map((happyHours as any[]).map((venue) => [venue.id, venue]));
  const items = list.items
    .map((item) => {
      const venue = venuesById.get(item.venueId);
      if (!venue) return null;
      return {
        venueId: item.venueId,
        createdAt: item.createdAt,
        feedback: item.feedback,
        myFeedback: item.myFeedback,
        notes: item.notes,
        myNote: item.myNote,
        venue: { ...venue, slug: venueSlug(venue) },
      };
    })
    .filter(Boolean);

  return json({
    list: {
      id: list.id,
      title: list.title,
      description: list.description,
      ownerName: list.ownerName,
      role: list.role,
      systemKey: list.systemKey,
      ratingsEnabled: list.ratingsEnabled,
      commentsEnabled: list.commentsEnabled,
      isDefault: list.isDefault,
      subscription: list.subscription,
      itemCount: list.itemCount,
      memberCount: list.memberCount,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt,
      access: list.access,
      canEdit: list.canEdit,
      canManageSharing: list.canManageSharing,
      inviteId: list.inviteId,
      inviteExpiresAt: list.inviteExpiresAt,
      items,
    },
    authenticated: Boolean(session),
  });
};

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to edit this list.'], 401);
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }
  try {
    const list = await updateHappyHourList(params.id!, session.userId, body);
    if (!list) return errorJson(['You do not have permission to edit this list.'], 403);
    return json({ list });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not update the list.'], 422);
  }
};

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in to delete this list.'], 401);
  try {
    const deleted = await deleteHappyHourList(params.id!, session.userId);
    if (!deleted) return errorJson(['Only the owner can delete this list.'], 403);
    return json({ deleted: true });
  } catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Could not delete the list.'], 422);
  }
};
