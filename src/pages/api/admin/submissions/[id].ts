import type { APIRoute } from 'astro';
import { getSubmission, updateSubmission } from '../../../../lib/store';
import { validateListing, cleanString } from '../../../../lib/validation';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../../lib/api';
import { appendVenue, updateVenue } from '../../../../lib/venueRepo';

export const prerender = false;

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const submission = await getSubmission(params.id!);
  if (!submission) return errorJson(['Submission not found.'], 404);

  const now = new Date().toISOString();
  const action = cleanString(body.action);

  if (action === 'deny') {
    const updated = await updateSubmission(submission.id, {
      status: 'denied',
      denialReason: cleanString(body.denialReason),
    });
    return json(updated);
  }

  if (action === 'edit' || action === 'approve') {
    // Coordinates are required for anything that ends up in happy-hours.json:
    // on approval, and on any later edit of an already-published submission,
    // since a live venue without them can't be placed on the homepage map.
    const { listing, errors } = validateListing(body.listing || submission.listing, {
      requireCoordinates: action === 'approve' || submission.status === 'approved',
    });
    if (errors.length) return errorJson(errors, 422);

    // An approved submission has a live venue behind it, and it stays visible
    // in the review queue afterwards (see admin.astro) — so editing it has to
    // reach that venue too, or the queue and the public page silently drift
    // apart. Approving one that's already approved updates rather than
    // appends, so a double-click can't publish the same venue twice.
    const publishedId = submission.status === 'approved' ? submission.approvedListingId : undefined;

    if (publishedId) {
      try {
        await updateVenue(publishedId, listing);
        return json(await updateSubmission(submission.id, { listing }));
      } catch (err: any) {
        return errorJson([`Could not update the published venue: ${err.message}`], 502);
      }
    }

    if (action === 'approve') {
      try {
        // A pending correction already carries the venue it targets. Approval
        // updates that venue in place; saving an edit above never does.
        if (submission.approvedListingId) {
          const approvedListing = {
            ...listing,
            verified: true,
            lastVerifiedAt: now.slice(0, 10),
          };
          await updateVenue(submission.approvedListingId, approvedListing);
          const updated = await updateSubmission(submission.id, {
            listing: approvedListing,
            status: 'approved',
            approvedListingId: submission.approvedListingId,
            submissionKind: 'update',
          });
          return json(updated);
        }

        const nextId = await appendVenue(listing, now);
        const updated = await updateSubmission(submission.id, {
          listing,
          status: 'approved',
          approvedListingId: nextId,
          submissionKind: 'new',
        });
        return json(updated);
      } catch (err: any) {
        return errorJson([`Could not publish venue: ${err.message}`], 502);
      }
    }

    const updated = await updateSubmission(submission.id, { listing });
    return json(updated);
  }

  return errorJson(['Action must be edit, approve, or deny.'], 400);
};
