import type { Venue } from './venues';
import { getVenues } from './venues';
import {
  getVenueOverride,
  getVenueOverrides,
  getVenueMenu,
  listPublishedVenuePhotos,
  type VenueOverride,
  type VenuePhoto,
} from './store';
import { cleanString, cleanList, isValidTime } from './validation';

// ---------------------------------------------------------------------------
// Where an admin-curated venue meets its owner's own edits.
//
// public/data/happy-hours.json is the base record: admins create it by
// approving a submission and edit it through /admin/venues/<slug>, and it
// only reaches visitors on a deploy. A verified claimant's edits live in the
// venue_overrides table (migrations/0004) and take effect immediately, so
// this module is what decides which wins — the override, field by field.
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
export function validateOwnerPatch(input: Record<string, any>): { patch: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];

  const days = cleanList(input.days);
  const deals = cleanList(input.deals);
  const patch: Record<string, unknown> = {
    days,
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
  if (!isValidTime(patch.startTime as string)) errors.push('Start time must use HH:MM 24-hour format.');
  if (!isValidTime(patch.endTime as string)) errors.push('End time must use HH:MM 24-hour format.');
  if (!deals.length) errors.push('Add at least one deal.');
  if (!patch.vibe) errors.push('Vibe is required.');
  if (!patch.address) errors.push('Address is required.');
  if (!/^https?:\/\//i.test(patch.website as string)) errors.push('Website must start with http:// or https://.');
  if (patch.phone && !/^\+?[0-9()\-.\s]{7,20}$/.test(patch.phone as string)) {
    errors.push('That phone number doesn’t look valid.');
  }
  // Only our own stored images — the route narrows this further to a
  // published photo of this same venue.
  if (patch.image && !/^\/api\/images\/[^/]+$/.test(patch.image as string)) {
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
 * which would otherwise text people the hours an owner has since corrected. */
export async function getMergedVenues(): Promise<Venue[]> {
  const overrides = await getVenueOverrides();
  return getVenues().map((venue) => mergeVenue(venue, overrides[venue.id]));
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
  const [photos, menu] = await Promise.all([listPublishedVenuePhotos(venueId), getVenueMenu(venueId)]);
  const publishedById = new Map(photos.map((photo) => [photo.id, publicPhoto(photo)]));

  return {
    photos: photos.map(publicPhoto),
    menu: menu.map((section) => ({
      id: section.id,
      title: section.title,
      note: section.note,
      items: section.items.map((item) => ({
        id: item.id,
        name: item.name,
        price: item.price,
        description: item.description,
        photo: (item.photoId && publishedById.get(item.photoId)) || null,
      })),
    })),
  };
}
