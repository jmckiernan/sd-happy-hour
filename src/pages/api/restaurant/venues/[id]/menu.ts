import type { APIRoute } from 'astro';
import {
  getVenueMenu,
  getMenuSection,
  getMenuItemVenue,
  createMenuSection,
  updateMenuSection,
  deleteMenuSection,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  countMenuSections,
  countMenuItems,
  getVenuePhoto,
} from '../../../../../lib/store';
import { getVenueManager, NOT_A_MANAGER_MESSAGE } from '../../../../../lib/venueManager';
import { cleanString } from '../../../../../lib/validation';
import { json, errorJson, readJsonBody } from '../../../../../lib/api';

export const prerender = false;

// The owner's menu editor: sections, and the items inside them.
//
// One action-dispatched POST rather than eight REST routes. Every operation
// here needs the identical preamble — resolve the venue, authorize the
// manager, and (for anything addressing an existing row) confirm that row
// belongs to *this* venue — so splitting them across files would mean copying
// that preamble eight times, which is how one copy ends up missing a check.
// Same pattern the submission queue uses (api/admin/submissions/[id].ts).
//
// Menu item photos reference venue_photos rather than an image key, so a dish
// photo carries the same screening decision as an album photo; the public
// renderer hides one that isn't published yet (src/lib/venueContent.ts).

const MAX_SECTIONS = 12;
const MAX_ITEMS_PER_SECTION = 60;

export const GET: APIRoute = async ({ params, cookies }) => {
  const venueId = Number(params.id);
  if (!Number.isInteger(venueId) || venueId <= 0) return errorJson(['Invalid venue id.'], 400);

  const manager = await getVenueManager(cookies, venueId);
  if (!manager) return errorJson([NOT_A_MANAGER_MESSAGE], 403);

  return json({ menu: await getVenueMenu(venueId), limits: { sections: MAX_SECTIONS, items: MAX_ITEMS_PER_SECTION } });
};

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const venueId = Number(params.id);
  if (!Number.isInteger(venueId) || venueId <= 0) return errorJson(['Invalid venue id.'], 400);

  const manager = await getVenueManager(cookies, venueId);
  if (!manager) return errorJson([NOT_A_MANAGER_MESSAGE], 403);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const action = cleanString(body.action);

  /** Confirms a section id belongs to the venue in the URL. Without this,
   * holding a claim on any one venue would be enough to edit every venue's
   * menu by passing someone else's section id. */
  async function requireOwnSection(sectionId: string) {
    const section = await getMenuSection(sectionId);
    if (!section || section.venueId !== venueId) return null;
    return section;
  }

  switch (action) {
    case 'create-section': {
      const title = cleanString(body.title).slice(0, 80);
      if (!title) return errorJson(['Give the section a name, like "Happy Hour Food".'], 422);
      if ((await countMenuSections(venueId)) >= MAX_SECTIONS) {
        return errorJson([`A menu can have at most ${MAX_SECTIONS} sections.`], 409);
      }
      const section = await createMenuSection(venueId, title, cleanString(body.note).slice(0, 200));
      return json({ section }, 201);
    }

    case 'update-section': {
      const section = await requireOwnSection(cleanString(body.sectionId));
      if (!section) return errorJson(['Section not found.'], 404);

      const title = body.title === undefined ? undefined : cleanString(body.title).slice(0, 80);
      if (title !== undefined && !title) return errorJson(['A section needs a name.'], 422);

      await updateMenuSection(section.id, {
        title,
        note: body.note === undefined ? undefined : cleanString(body.note).slice(0, 200),
        sortOrder: body.sortOrder === undefined ? undefined : Number(body.sortOrder),
      });
      return json({ menu: await getVenueMenu(venueId) });
    }

    case 'delete-section': {
      const section = await requireOwnSection(cleanString(body.sectionId));
      if (!section) return errorJson(['Section not found.'], 404);
      // Items go with it (ON DELETE CASCADE) — that's what removing a section
      // means to the owner.
      await deleteMenuSection(section.id);
      return json({ menu: await getVenueMenu(venueId) });
    }

    case 'create-item': {
      const section = await requireOwnSection(cleanString(body.sectionId));
      if (!section) return errorJson(['Section not found.'], 404);

      const name = cleanString(body.name).slice(0, 120);
      if (!name) return errorJson(['Give the item a name.'], 422);
      if ((await countMenuItems(section.id)) >= MAX_ITEMS_PER_SECTION) {
        return errorJson([`A section can have at most ${MAX_ITEMS_PER_SECTION} items.`], 409);
      }

      const photoId = await resolvePhotoId(body.photoId, venueId);
      if (photoId === 'invalid') return errorJson(['That photo isn’t one of this listing’s photos.'], 422);
      if (body.showPhotoInGallery !== undefined && typeof body.showPhotoInGallery !== 'boolean') {
        return errorJson(['Gallery visibility must be true or false.'], 422);
      }

      const item = await createMenuItem({
        sectionId: section.id,
        name,
        // Free text on purpose: real menus say "$8", "6/9", "market price".
        price: cleanString(body.price).slice(0, 40),
        description: cleanString(body.description).slice(0, 400),
        photoId,
        // Existing behavior is preserved unless the owner deliberately opts
        // this item out of the venue gallery.
        showPhotoInGallery: body.showPhotoInGallery !== false,
      });
      return json({ item }, 201);
    }

    case 'update-item': {
      const itemId = cleanString(body.itemId);
      const item = await getMenuItemVenue(itemId);
      if (!item || item.venueId !== venueId) return errorJson(['Item not found.'], 404);

      const name = body.name === undefined ? undefined : cleanString(body.name).slice(0, 120);
      if (name !== undefined && !name) return errorJson(['An item needs a name.'], 422);

      // `photoId: null` clears the photo; omitting it leaves it alone.
      const clearPhoto = body.photoId === null;
      const photoId = clearPhoto ? null : await resolvePhotoId(body.photoId, venueId);
      if (photoId === 'invalid') return errorJson(['That photo isn’t one of this listing’s photos.'], 422);
      if (body.showPhotoInGallery !== undefined && typeof body.showPhotoInGallery !== 'boolean') {
        return errorJson(['Gallery visibility must be true or false.'], 422);
      }

      await updateMenuItem(item.id, {
        name,
        price: body.price === undefined ? undefined : cleanString(body.price).slice(0, 40),
        description: body.description === undefined ? undefined : cleanString(body.description).slice(0, 400),
        photoId,
        showPhotoInGallery: body.showPhotoInGallery,
        sortOrder: body.sortOrder === undefined ? undefined : Number(body.sortOrder),
        clearPhoto,
      });
      return json({ menu: await getVenueMenu(venueId) });
    }

    case 'delete-item': {
      const itemId = cleanString(body.itemId);
      const item = await getMenuItemVenue(itemId);
      if (!item || item.venueId !== venueId) return errorJson(['Item not found.'], 404);
      await deleteMenuItem(item.id);
      return json({ menu: await getVenueMenu(venueId) });
    }

    default:
      return errorJson(['Unknown menu action.'], 400);
  }
};

/**
 * Turns a submitted photo id into something safe to store: the id itself if it
 * belongs to this venue, undefined if none was supplied, or the string
 * 'invalid' for an id that exists elsewhere or not at all.
 *
 * A photo still in review is allowed to be attached — the item just renders
 * without a photo until it clears, which is friendlier than making the owner
 * come back and attach it later.
 */
async function resolvePhotoId(raw: unknown, venueId: number): Promise<string | undefined | 'invalid'> {
  const photoId = cleanString(raw);
  if (!photoId) return undefined;

  const photo = await getVenuePhoto(photoId);
  if (!photo || photo.venueId !== venueId || photo.status === 'rejected') return 'invalid';
  return photo.id;
}
