import type { APIRoute } from 'astro';
import { errorJson, json, readJsonBody } from '../../../../lib/api';
import { getSession } from '../../../../lib/session';
import {
  removeVenueFollow,
  saveVenueFollow,
  VenueFollowServiceError,
  type VenueFollowPatch,
} from '../../../../lib/venueFollowService';

export const prerender = false;

function serviceErrorResponse(error: unknown): Response | null {
  if (!(error instanceof VenueFollowServiceError)) return null;
  return json({ code: error.code, errors: error.errors }, error.status);
}

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Expected an object.');
    }
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const unknown = Object.keys(body).filter(
    (key) => key !== 'happyHourAlertsEnabled' && key !== 'promotionAlertsEnabled' && key !== 'channels'
  );
  if (unknown.length) return errorJson([`Unknown fields: ${unknown.join(', ')}.`], 400);

  const errors: string[] = [];
  const patch: VenueFollowPatch = {};
  if (body.happyHourAlertsEnabled !== undefined) {
    if (typeof body.happyHourAlertsEnabled !== 'boolean') {
      errors.push('happyHourAlertsEnabled must be a boolean.');
    } else patch.happyHourAlertsEnabled = body.happyHourAlertsEnabled;
  }
  if (body.promotionAlertsEnabled !== undefined) {
    if (typeof body.promotionAlertsEnabled !== 'boolean') {
      errors.push('promotionAlertsEnabled must be a boolean.');
    } else patch.promotionAlertsEnabled = body.promotionAlertsEnabled;
  }
  if (body.channels !== undefined) {
    if (!body.channels || typeof body.channels !== 'object' || Array.isArray(body.channels)) {
      errors.push('channels must be an object.');
    } else {
      const channels = body.channels as Record<string, unknown>;
      const unknownChannels = Object.keys(channels).filter((key) => key !== 'email' && key !== 'text');
      if (unknownChannels.length) errors.push(`Unknown channel fields: ${unknownChannels.join(', ')}.`);
      const cleanChannels: NonNullable<VenueFollowPatch['channels']> = {};
      if (channels.email !== undefined) {
        if (typeof channels.email !== 'boolean') errors.push('channels.email must be a boolean.');
        else cleanChannels.email = channels.email;
      }
      if (channels.text !== undefined) {
        if (typeof channels.text !== 'boolean') errors.push('channels.text must be a boolean.');
        else cleanChannels.text = channels.text;
      }
      patch.channels = cleanChannels;
    }
  }
  if (errors.length) return errorJson(errors, 422);

  try {
    return json(await saveVenueFollow(session.userId, Number(params.venueId), patch));
  } catch (error) {
    const response = serviceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};

export const PATCH = PUT;

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['User login required.'], 401);
  try {
    await removeVenueFollow(session.userId, Number(params.venueId));
    return json({ ok: true, venueId: Number(params.venueId) });
  } catch (error) {
    const response = serviceErrorResponse(error);
    if (response) return response;
    throw error;
  }
};
