import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT_DIR } from './constants.mjs';
import { sniffMediaFromBytes } from './media.mjs';
import { rasterizePdfPages } from './pdf-raster.mjs';

const VENUE_IMAGE_DIR = path.join(ROOT_DIR, 'public', 'images', 'venues');
const MAX_GALLERY_FLYERS = 2;

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function extensionFor(mediaType) {
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/webp') return 'webp';
  if (mediaType === 'image/gif') return 'gif';
  return 'jpg';
}

async function imagesFromPage(page) {
  const sniffed = sniffMediaFromBytes(page.bytes);
  const kind = sniffed?.kind || page.kind;
  if (kind === 'image') {
    return [{
      bytes: page.bytes,
      mediaType: sniffed?.mediaType || 'image/jpeg',
      sourceUrl: page.url || null,
      generated: Boolean(page.generated),
    }];
  }
  if (kind === 'pdf') {
    try {
      const rendered = await rasterizePdfPages(page.bytes, { maxPages: MAX_GALLERY_FLYERS });
      return rendered.map((image) => ({ ...image, sourceUrl: page.url || null }));
    } catch (error) {
      console.warn(`  ~ PDF flyer render failed (${error.message})`);
      return [];
    }
  }
  return [];
}

/**
 * Write the board we typeset from `hhMenu` into the venue gallery.
 *
 * Separate from `persistMenuFlyers` for two reasons that both caused bugs.
 *
 * The filename is its own `-hh-menu-board` slot. Flyers are numbered from
 * `-hh-menu`, which is the same name the scraped original already occupies, so
 * rendering a board for a venue whose flyer we had transcribed would overwrite
 * the provenance image the transcription is checked against.
 *
 * And it merges rather than replaces. The gallery was once assumed to hold only
 * the flyer the board supersedes, so the caller assigned over the whole array;
 * now that it also holds genuine venue photographs, that silently deleted them.
 */
export async function persistMenuBoard(venue, images) {
  const pages = (Array.isArray(images) ? images : [images]).filter((image) => image?.bytes?.length);
  if (!venue?.id || !pages.length) return venue.galleryImages || [];
  await fs.mkdir(VENUE_IMAGE_DIR, { recursive: true });

  const boards = [];
  for (const [index, image] of pages.entries()) {
    const sniffed = sniffMediaFromBytes(image.bytes);
    const ext = extensionFor(sniffed?.mediaType || image.mediaType || 'image/png');
    // Page one keeps the unsuffixed name so a menu that grows a second page
    // does not orphan the file every other record already points at.
    const suffix = index === 0 ? 'hh-menu-board' : `hh-menu-board-${index + 1}`;
    const filename = `${venue.id}-${slugify(venue.name)}-${suffix}.${ext}`;
    await fs.writeFile(path.join(VENUE_IMAGE_DIR, filename), image.bytes);
    boards.push({
      url: `/images/venues/${filename}`,
      caption: pages.length > 1 ? `Happy hour menu (page ${index + 1} of ${pages.length})` : 'Happy hour menu',
      sourceUrl: image.sourceUrl || venue.hhMenu?.sourceUrl || null,
      generated: true,
    });
  }

  // The boards lead, in page order, because they are what a reader zooms into
  // to read the menu; the venue's own photographs follow them.
  const photos = (venue.galleryImages || []).filter((existing) => !existing.generated);
  return [...boards, ...photos];
}

/** Write happy-hour menu images (and rasterized PDF pages) into the venue gallery. */
export async function persistMenuFlyers(venue, mediaPages = []) {
  if (!venue?.id || !mediaPages.length) return [];
  await fs.mkdir(VENUE_IMAGE_DIR, { recursive: true });
  const gallery = [];
  for (const page of mediaPages) {
    if (!page?.bytes?.length) continue;
    const remaining = MAX_GALLERY_FLYERS - gallery.length;
    if (remaining <= 0) break;
    const images = (await imagesFromPage(page)).slice(0, remaining);
    for (const image of images) {
      const ext = extensionFor(image.mediaType);
      const suffix = gallery.length === 0 ? 'hh-menu' : `hh-menu-${gallery.length + 1}`;
      const filename = `${venue.id}-${slugify(venue.name)}-${suffix}.${ext}`;
      await fs.writeFile(path.join(VENUE_IMAGE_DIR, filename), image.bytes);
      gallery.push({
        url: `/images/venues/${filename}`,
        caption: 'Happy hour menu',
        sourceUrl: image.sourceUrl,
        // Boards we typeset ourselves can be re-rendered from `hhMenu`;
        // a flyer scraped from the venue cannot.
        ...(image.generated ? { generated: true } : {}),
      });
    }
  }
  return gallery;
}
