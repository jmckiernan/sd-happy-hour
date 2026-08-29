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
      });
    }
  }
  return gallery;
}
