import type { APIRoute } from 'astro';
import { getUserByShareId, getAlert } from '../../../../lib/store';
import { json, errorJson } from '../../../../lib/api';
import { alertMatchesVenue } from '../../../../lib/venues';
import { getPublicMergedVenues } from '../../../../lib/venueContent';

export const prerender = false;

// Public (no login required) read-only preview of one shared alert, used by
// /alerts/shared/?id=<shareId>&alert=<alertId>. Reuses the same shareId
// already on the User record for saved-list sharing — no separate alert
// share token needed since the (shareId, alertId) pair is unique.
export const GET: APIRoute = async ({ params }) => {
  const owner = await getUserByShareId(params.shareId!);
  if (!owner) return errorJson(['Shared alert not found.'], 404);

  const alert = await getAlert(owner.id, params.alertId!);
  if (!alert) return errorJson(['Shared alert not found.'], 404);

  const matches = (await getPublicMergedVenues()).filter((venue) => alertMatchesVenue(alert.filters, venue));

  return json({
    ownerName: owner.name,
    shareId: owner.shareId,
    alertId: alert.id,
    name: alert.name,
    filters: alert.filters,
    alertKinds: alert.alertKinds,
    matchCount: matches.length,
    matches: matches.slice(0, 12).map((v) => ({ id: v.id, name: v.name, neighborhood: v.neighborhood })),
  });
};
