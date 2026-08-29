import type { Venue } from './venues';
import { getVenues, isPubliclyListed } from './venues';
import {
  getVenueOverride,
  getVenueOverrides,
  getVenueMenu,
  listPublishedVenuePhotos,
  listPublishedVenueGalleryPhotos,
  listPublishedVenueIds,
  type VenueOverride,
  type VenuePhoto,
} from './store';
import { cleanString, cleanList, isValidTime } from './validation';

// ---------------------------------------------------------------------------
// Where an admin-curated venue meets runtime listing edits.
//
// public/data/happy-hours.json is the base record: admins create it by
// approving a submission and edit it through /admin/venues/<slug>, and it
// only reaches visitors on a deploy. A verified claimant's edits — plus an
// admin's field-level corrections that must be live before that deploy — live
// in venue_overrides (migrations/0004), so this module decides what wins.
//
// The album and menu have no counterpart in the JSON file at all; they're
// owner-only content, assembled here for the public venue page.
// ---------------------------------------------------------------------------

/**
 * The only listing fields a verified owner may change.
 *
 * Everything omitted is admin territory for a specific reason: `name` and
 * `neighborhood` are the venue's identity and its URL slug, `lat`/`lng` place
 * it on the homepage map, and `verified`/`lastVerifiedAt` are our trust
 * signal about the listing — an owner attesting to their own verification
 * would make that badge meaningless. `sourceUrl` is the evidence trail for
 * the deals, which is ours, not theirs.
 *
 * `image` is here but constrained further at the route level: an owner can
 * only point it at one of their own *published* album photos, so the featured
 * image can never be something screening hasn't cleared.
 */
export const OWNER_EDITABLE_FIELDS = [
  'days',
  'openTime',
  'closeTime',
  'startTime',
  'endTime',
  'deals',
  'dealTypes',
  'features',
  'vibe',
  'website',
  'phone',
  'address',
  'image',
] as const;

export type OwnerEditableField = (typeof OWNER_EDITABLE_FIELDS)[number];

/** Copies the live-editable portion of a complete venue/listing record.
 *
 * Admin saves use the same override channel as owner saves so these fields
 * can reach the public site without waiting for a deploy. Keeping the picker
 * here makes that boundary explicit and prevents an admin-only field such as
 * `verified` or `lat` from accidentally entering the public override. */
export function pickOwnerEditableFields(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of OWNER_EDITABLE_FIELDS) patch[field] = input[field];
  return patch;
}

const VALID_DAYS = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

/**
 * Validates an owner's submitted patch, returning only the owner-editable
 * fields. Rules match validateListing() in validation.ts for the fields they
 * share — an owner-edited venue must not be able to reach a shape that admin
 * approval would have rejected.
 *
 * Every field is required rather than optional: the dashboard always submits
 * the complete set, and setVenueOverride() replaces the stored patch
 * wholesale, so a missing field would silently revert to the base value.
 */
export function validateOwnerPatch(
  input: Record<string, any>,
  { allowedExistingImage = '' }: { allowedExistingImage?: string } = {}
): { patch: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];

  const days = cleanList(input.days);
  const deals = cleanList(input.deals);
  const patch: Record<string, unknown> = {
    days,
    openTime: cleanString(input.openTime),
    closeTime: cleanString(input.closeTime),
    startTime: cleanString(input.startTime),
    endTime: cleanString(input.endTime),
    deals,
    dealTypes: cleanList(input.dealTypes),
    features: cleanList(input.features),
    vibe: cleanString(input.vibe),
    website: cleanString(input.website),
    phone: cleanString(input.phone).slice(0, 20),
    address: cleanString(input.address),
    image: cleanString(input.image),
  };

  if (!days.length || days.some((day) => !VALID_DAYS.has(day))) errors.push('Choose at least one valid day.');
  const openTime = patch.openTime as string;
  const closeTime = patch.closeTime as string;
  if (Boolean(openTime) !== Boolean(closeTime)) errors.push('Add both venue open and close times, or leave both blank.');
  if (openTime && !isValidTime(openTime)) errors.push('Venue open time must use HH:MM 24-hour format.');
  if (closeTime && !isValidTime(closeTime)) errors.push('Venue close time must use HH:MM 24-hour format.');
  if (!isValidTime(patch.startTime as string)) errors.push('Happy hour start time must use HH:MM 24-hour format.');
  if (!isValidTime(patch.endTime as string)) errors.push('Happy hour end time must use HH:MM 24-hour format.');
  if (!deals.length) errors.push('Add at least one deal.');
  if (!patch.vibe) errors.push('Vibe is required.');
  if (!patch.address) errors.push('Address is required.');
  if (!/^https?:\/\//i.test(patch.website as string)) errors.push('Website must start with http:// or https://.');
  if (patch.phone && !/^\+?[0-9()\-.\s]{7,20}$/.test(patch.phone as string)) {
    errors.push('That phone number doesn’t look valid.');
  }
  // Only our own stored images — the route narrows this further to a
  // published photo of this same venue.
  if (
    patch.image &&
    patch.image !== allowedExistingImage &&
    !/^\/api\/images\/[^/]+$/.test(patch.image as string)
  ) {
    errors.push('Featured photo must be one of your uploaded photos.');
  }

  return { patch, errors };
}

/** Base venue with the owner's patch laid over it. A plain spread: the patch
 * only ever holds whole values for owner-editable fields (validateOwnerPatch
 * guarantees that), so there's nothing to merge field-by-field. Empty strings
 * in the patch are meaningful — the owner clearing their phone number, say —
 * so they overwrite rather than falling back. */
export function mergeVenue(venue: Venue, override: VenueOverride | null | undefined): Venue {
  if (!override) return venue;
  return { ...venue, ...override.patch, id: venue.id } as Venue;
}

/** Every venue with its owner's edits applied. Used by anything that reasons
 * about the venue set server-side — notably alert dispatch (lib/notify.ts),
 * which would otherwise text people the hours an owner has since corrected.
 *
 * Includes unlisted venues, so callers facing the public should reach for
 * getPublicMergedVenues() instead. The owner dashboard wants this one: an
 * owner has to be able to see and work on a listing that isn't public yet. */
export async function getMergedVenues(): Promise<Venue[]> {
  const overrides = await getVenueOverrides();
  return getVenues().map((venue) => mergeVenue(venue, overrides[venue.id]));
}

/** Merged venues, minus anything not cleared for public view. Resolves
 * visibility against publication records, so a venue just cleared by a claim
 * is included straight away rather than after the next deploy. */
export async function getPublicMergedVenues(): Promise<Venue[]> {
  const [overrides, publishedVenueIds] = await Promise.all([
    getVenueOverrides(),
    listPublishedVenueIds(),
  ]);
  return getVenues()
    .filter((venue) => isPubliclyListed(venue, publishedVenueIds))
    .map((venue) => mergeVenue(venue, overrides[venue.id]));
}

/** One venue, merged. */
export async function getMergedVenue(venueId: number): Promise<Venue | null> {
  const venue = getVenues().find((v) => v.id === venueId);
  if (!venue) return null;
  return mergeVenue(venue, await getVenueOverride(venueId));
}

// ---------------------------------------------------------------------------
// Public shapes — what the venue page actually renders. Blob keys become
// URLs here, and anything not cleared for public view is already excluded by
// the queries these call.
// ---------------------------------------------------------------------------

export interface PublicPhoto {
  id: string;
  url: string;
  caption: string;
}

export interface PublicMenuItem {
  id: string;
  name: string;
  price: string;
  description: string;
  photo: PublicPhoto | null;
}

export interface PublicMenuSection {
  id: string;
  title: string;
  note: string;
  items: PublicMenuItem[];
}

export interface PublicVenueContent {
  photos: PublicPhoto[];
  menu: PublicMenuSection[];
}

export function publicPhoto(photo: VenuePhoto): PublicPhoto {
  return { id: photo.id, url: `/api/images/${photo.imageKey}`, caption: photo.caption };
}

/**
 * The album and menu for one venue, ready to render.
 *
 * Menu item photos are resolved against the *published* album only. A dish
 * photo still in review therefore shows as an item without a photo rather
 * than a broken or unscreened image, and it starts appearing the moment the
 * photo is approved with no further action from the owner.
 */
export async function getVenueContent(venueId: number): Promise<PublicVenueContent> {
  const [galleryPhotos, allPhotos, menu] = await Promise.all([
    listPublishedVenueGalleryPhotos(venueId),
    listPublishedVenuePhotos(venueId),
    getVenueMenu(venueId)
  ]);

  // Create maps of ALL photos (gallery + menu item) for menu item linking and
  // for the owner's per-item "also show in gallery" choice.
  const publishedRowsById = new Map(allPhotos.map((photo) => [photo.id, photo]));
  const publishedById = new Map(allPhotos.map((photo) => [photo.id, publicPhoto(photo)]));
  // A photo can be reused by more than one item. It appears when at least one
  // referencing item opts in; if every referencing item opts out, even a
  // legacy photo typed as a venue photo is removed from the public gallery.
  const galleryChoiceByPhotoId = new Map<string, boolean>();
  for (const section of menu) {
    for (const item of section.items) {
      if (!item.photoId) continue;
      galleryChoiceByPhotoId.set(
        item.photoId,
        Boolean(galleryChoiceByPhotoId.get(item.photoId)) || item.showPhotoInGallery
      );
    }
  }

  const visibleGalleryPhotos = galleryPhotos.filter((photo) =>
    !galleryChoiceByPhotoId.has(photo.id) || galleryChoiceByPhotoId.get(photo.id) === true
  );
  const publicGallery = visibleGalleryPhotos.map(publicPhoto);
  const publicGalleryIds = new Set(visibleGalleryPhotos.map((photo) => photo.id));

  for (const section of menu) {
    for (const item of section.items) {
      if (!item.showPhotoInGallery || !item.photoId || publicGalleryIds.has(item.photoId)) continue;
      const photo = publishedRowsById.get(item.photoId);
      if (!photo) continue;
      const galleryPhoto = publicPhoto(photo);
      // Menu-only uploads normally have no caption; the item name is much more
      // useful in the venue lightbox than a blank caption.
      if (!galleryPhoto.caption) galleryPhoto.caption = item.name;
      publicGallery.push(galleryPhoto);
      publicGalleryIds.add(item.photoId);
    }
  }

  return {
    photos: publicGallery,
    menu: menu.map((section) => ({
      id: section.id,
      title: section.title,
      note: section.note,
      items: section.items.map((item) => ({
        id: item.id,
        name: item.name,
        price: item.price,
        description: item.description,
        // Menu items can reference any published photo (gallery or menu_item type)
        photo: (item.photoId && publishedById.get(item.photoId)) || null,
      })),
    })),
  };
}
