import type { APIRoute } from 'astro';
import { createSubmission } from '../../lib/store';
import { validateSubmission } from '../../lib/validation';
import { json, errorJson, readJsonBody } from '../../lib/api';
import { getVenueById } from '../../lib/venues';

export const prerender = false;

// Public endpoint — anyone can submit a venue for review (src/pages/submit.astro).
// Submissions land in the pending queue; an admin approves or denies them
// from /admin (see api/admin/submissions/[id].ts).
export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  let targetVenueId: number | undefined;
  let listingInput = body;

  if (body.existingVenueId !== undefined && body.existingVenueId !== null && body.existingVenueId !== '') {
    const parsedId = Number(body.existingVenueId);
    if (!Number.isSafeInteger(parsedId) || parsedId <= 0) {
      return errorJson(['Venue update target is invalid.'], 422);
    }

    const targetVenue = getVenueById(parsedId);
    if (!targetVenue) return errorJson(['Venue update target was not found.'], 404);
    targetVenueId = parsedId;

    // The public correction form deliberately exposes only ordinary listing
    // details. Preserve coordinates, imagery, verification and venue hours so
    // a correction cannot clear or forge admin-managed fields.
    listingInput = {
      name: body.name,
      neighborhood: body.neighborhood,
      address: body.address,
      website: body.website,
      sourceUrl: body.sourceUrl,
      phone: body.phone,
      startTime: body.startTime,
      endTime: body.endTime,
      days: body.days,
      deals: body.deals,
      vibe: body.vibe,
      dealTypes: body.dealTypes,
      lat: targetVenue.lat,
      lng: targetVenue.lng,
      openTime: targetVenue.openTime,
      closeTime: targetVenue.closeTime,
      verified: targetVenue.verified,
      lastVerifiedAt: targetVenue.lastVerifiedAt,
      image: targetVenue.image,
      imageCrop: targetVenue.imageCrop,
    };
  }

  const { listing, contact, errors } = validateSubmission({
    ...listingInput,
    contactName: body.contactName,
    contactEmail: body.contactEmail,
    relationshipToVenue: body.relationshipToVenue,
    notes: body.notes,
  }, {
    requireRelationshipToVenue: targetVenueId !== undefined,
  });
  if (errors.length) return errorJson(errors, 422);

  const submission = await createSubmission({ contact, listing, approvedListingId: targetVenueId });
  return json({ id: submission.id, status: submission.status }, 201);
};
