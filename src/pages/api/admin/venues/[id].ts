import type { APIRoute } from 'astro';
import { validateListing, normalizeListingConsistency } from '../../../../lib/validation';
import { getAdminUser } from '../../../../lib/admins';
import { json, errorJson, readJsonBody } from '../../../../lib/api';
import { fetchVenues, updateVenue, type VenueFileSnapshot } from '../../../../lib/venueRepo';
import { describeGitHubError, describeRepoError } from '../../../../lib/github';
import type { Venue } from '../../../../lib/venues';
import { getVenueOverride, mergeVenueOverride, type VenueOverride } from '../../../../lib/store';
import { mergeVenue, LIVE_LISTING_FIELDS } from '../../../../lib/venueContent';
import {
  isLocalImageStorageAvailable,
  isNetlifyBlobsAvailable,
  readImageStrict,
  storedImageUrlKey,
} from '../../../../lib/imageStore';

export const prerender = false;

// Edits an already-published venue. The repository remains the durable source
// used by the next build, while the live-editable portion is also written to
// venue_overrides so hours, deals, contact details, the featured image and its
// framing are visible immediately. Admin-only identity/map/trust fields still
// arrive with the next deploy because they are intentionally excluded from
// that override.
//
// Coordinates are required here for the same reason they are on approval:
// a live venue without them can't be placed on the homepage map.

function venueIdFrom(value: string | undefined): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function storedImageKey(image: string): string | null {
  return storedImageUrlKey(image);
}

const LIVE_LISTING_FIELD_SET = new Set<string>(LIVE_LISTING_FIELDS);

function sameListingValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const GET: APIRoute = async ({ params, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  const id = venueIdFrom(params.id);
  if (!id) return errorJson(['Invalid venue id.'], 400);

  try {
    // Read the repository rather than the build-time import. An admin can
    // reopen this page before the deploy triggered by their previous save;
    // starting from the repo prevents a second save from reverting it.
    const { venues } = await fetchVenues();
    const venue = venues.find((entry) => Number(entry.id) === id);
    if (!venue) return errorJson([`No venue with id ${id}.`], 404);

    const override = await getVenueOverride(id);
    return json({ venue: mergeVenue(venue, override), hasLiveOverride: Boolean(override) });
  } catch (err: any) {
    return errorJson([describeGitHubError(err, 'load this venue')], 502);
  }
};

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const admin = await getAdminUser(cookies);
  if (!admin) return errorJson(['Sign in at /account/ with an authorized admin email.'], 401);

  const id = venueIdFrom(params.id);
  if (!id) return errorJson(['Invalid venue id.'], 400);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const { listing, errors } = validateListing(body.listing || {}, { requireCoordinates: true });
  if (errors.length) return errorJson(errors, 422);

  const { listing: baseline, errors: baselineErrors } = validateListing(
    normalizeListingConsistency(body.baseline || {}),
    { requireCoordinates: true }
  );
  if (baselineErrors.length) {
    return errorJson(['This editor is out of date. Reload the page before saving.'], 409);
  }

  const listingRecord = listing as unknown as Record<string, unknown>;
  const baselineRecord = baseline as unknown as Record<string, unknown>;
  const changedFields = Object.keys(listingRecord).filter(
    (field) => !sameListingValue(listingRecord[field], baselineRecord[field])
  );

  let snapshot: VenueFileSnapshot;
  let currentOverride: VenueOverride | null;
  let repositoryVenue: Venue;
  try {
    const [venueFile, override] = await Promise.all([fetchVenues(), getVenueOverride(id)]);
    const foundVenue = venueFile.venues.find((entry) => Number(entry.id) === id);
    if (!foundVenue) return errorJson([`No venue with id ${id}.`], 404);
    snapshot = venueFile;
    repositoryVenue = foundVenue;
    currentOverride = override;
  } catch (err: any) {
    return errorJson([describeRepoError(err, 'load the current live venue')], 502);
  }

  // Apply only fields the admin actually changed from the form they loaded.
  // Owner-managed values shown in that baseline therefore do not get copied
  // into GitHub or overwrite a newer owner save merely because they were
  // present in the full form submission.
  const repositoryInput = { ...repositoryVenue } as Record<string, unknown>;
  for (const field of changedFields) repositoryInput[field] = listingRecord[field];
  const repositoryValidation = validateListing(repositoryInput, { requireCoordinates: true });
  if (repositoryValidation.errors.length) {
    return errorJson(
      ['The repository venue changed while this editor was open. Reload and try again.'],
      409
    );
  }
  const repositoryListing = repositoryValidation.listing;

  const liveDelta: Record<string, unknown> = {};
  for (const field of changedFields) {
    if (LIVE_LISTING_FIELD_SET.has(field)) liveDelta[field] = listingRecord[field];
  }

  const currentListing = mergeVenue(repositoryVenue, currentOverride);
  const currentImage = String(currentListing.image || '');
  const repositoryImage = String(repositoryListing.image || '');
  const imageWasEdited = changedFields.includes('image');
  const urlsToVerify = new Set<string>();
  if (repositoryImage.startsWith('/api/images/')) urlsToVerify.add(repositoryImage);
  if (!imageWasEdited && currentImage.startsWith('/api/images/')) urlsToVerify.add(currentImage);

  const imageAvailability = new Map<string, boolean>();
  const durableKeys = [...urlsToVerify]
    .map((url) => ({ url, key: storedImageKey(url) }))
    .filter((entry): entry is { url: string; key: string } => Boolean(entry.key));

  if (durableKeys.length && !isNetlifyBlobsAvailable()) {
    if (!isLocalImageStorageAvailable()) {
      return errorJson(
        ['Image storage is unavailable in this deployment. No venue changes were saved; retry shortly.'],
        502
      );
    }
    return errorJson(
      [
        'Stored images cannot be published from local development. Upload and save from the deployed admin page.',
      ],
      409
    );
  }

  for (const { url, key } of durableKeys) {
    try {
      imageAvailability.set(url, Boolean(await readImageStrict(key)));
    } catch (err: any) {
      return errorJson([`Could not verify the uploaded image in durable storage: ${err.message}`], 502);
    }
  }

  function isAvailableStoredImage(url: string): boolean {
    if (!url.startsWith('/api/images/')) return true;
    const key = storedImageKey(url);
    return Boolean(key) && imageAvailability.get(url) === true;
  }

  let imageFallbackApplied = false;
  if (!isAvailableStoredImage(repositoryImage)) {
    if (imageWasEdited) {
      const malformed = repositoryImage.startsWith('/api/images/') && !storedImageKey(repositoryImage);
      return errorJson(
        [
          malformed
            ? 'Featured image has an invalid stored-image URL.'
            : 'The uploaded image is missing from durable storage. Upload it again, then retry Save.',
        ],
        malformed ? 422 : 409
      );
    }
    // A broken repository image predates this edit. Do not recommit it while
    // saving an unrelated correction.
    repositoryListing.image = '';
    imageFallbackApplied = true;
  }

  if (!imageWasEdited && !isAvailableStoredImage(currentImage)) {
    // A stale live override (Craft & Commerce's exact failure mode) should be
    // healed immediately without discarding any concurrent owner fields. If
    // the repository already has a healthy featured image, reveal that rather
    // than masking it with an empty override; otherwise use the stock fallback.
    liveDelta.image = isAvailableStoredImage(repositoryImage) ? repositoryImage : '';
    imageFallbackApplied = true;
  }

  let updated;
  try {
    // Durable snapshot for future builds and social/OG metadata. Reusing the
    // repository snapshot above avoids a second read while the SHA still
    // provides GitHub's normal optimistic-concurrency guard.
    updated = await updateVenue(id, repositoryListing, snapshot);
  } catch (err: any) {
    const missing = /^No venue with id/.test(err.message);
    return errorJson([missing ? err.message : describeGitHubError(err, 'save this venue')], missing ? 404 : 502);
  }

  let effectiveOverride = currentOverride;
  if (Object.keys(liveDelta).length) {
    try {
      // SQL merges this delta into whatever is current at write time. If the
      // owner saved newer hours after our read, an image-only admin edit keeps
      // those hours rather than replacing the whole patch with a stale copy.
      effectiveOverride = await mergeVenueOverride(id, liveDelta, admin.id);
    } catch (err: any) {
      return errorJson(
        [
          `The repository was updated, but the live listing could not be refreshed: ${err.message}. Retry Save to publish it now.`,
        ],
        502
      );
    }
  }

  return json({
    venue: mergeVenue(updated, effectiveOverride),
    liveNow: Object.keys(liveDelta).length > 0,
    updatedAt: effectiveOverride?.updatedAt ?? null,
    imageFallbackApplied,
  });
};
