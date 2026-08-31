// Non-destructive framing for gallery images.
//
// A gallery image is a flyer or a menu board we scraped or typeset, and the
// original file is the only copy we have — Feature-1 zoom reads it to make
// dense menu text legible, and the same file is framed at several aspect
// ratios (card, gallery tile, lightbox). So an admin adjusting what is
// visible in a frame stores a focal point and a zoom factor here rather than
// re-cropping the file: the original survives, the choice is re-editable, and
// each surface applies it at its own ratio.
//
// Client-safe by design — the admin form builder (lib/listingForm.ts) and the
// venue page's client script both import it, so it must stay free of server
// imports.

export interface GalleryCrop {
  /** Focal point across the image, 0 (left) to 100 (right). */
  x: number;
  /** Focal point down the image, 0 (top) to 100 (bottom). */
  y: number;
  /** Magnification about the focal point. 1 means the whole frame-filling
   * image, which is what an image with no crop already does. */
  scale?: number;
}

export const DEFAULT_GALLERY_CROP: Required<GalleryCrop> = { x: 50, y: 50, scale: 1 };
export const MAX_GALLERY_CROP_SCALE = 4;

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isScale(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 1 && value <= MAX_GALLERY_CROP_SCALE;
}

/** Shape check for a stored `crop`, shared by the JSON validator's rules.
 * `scale` is optional so the common "just move it" adjustment stores two
 * numbers rather than three. */
export function isGalleryCrop(value: unknown): value is GalleryCrop {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const crop = value as Record<string, unknown>;
  if (!isPercent(crop.x) || !isPercent(crop.y)) return false;
  if ('scale' in crop && crop.scale !== undefined && !isScale(crop.scale)) return false;
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds to a tenth of a percent — finer than anyone can drag, and it keeps
 * happy-hours.json from filling up with float noise. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * A stored crop coerced into range, or null when it is absent, unusable, or
 * says the same thing as no crop at all. Callers treat null as "render this
 * image the way it has always rendered", which is what keeps the thousands of
 * existing gallery rows looking identical.
 */
export function normalizeGalleryCrop(value: unknown): GalleryCrop | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const crop = value as Record<string, unknown>;
  const x = Number(crop.x);
  const y = Number(crop.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const rawScale = crop.scale === undefined || crop.scale === null ? 1 : Number(crop.scale);
  const scale = Number.isFinite(rawScale) ? clamp(rawScale, 1, MAX_GALLERY_CROP_SCALE) : 1;
  const normalized: GalleryCrop = { x: round(clamp(x, 0, 100)), y: round(clamp(y, 0, 100)) };
  if (scale > 1) normalized.scale = round(scale);

  const isDefault = normalized.x === DEFAULT_GALLERY_CROP.x
    && normalized.y === DEFAULT_GALLERY_CROP.y
    && normalized.scale === undefined;
  return isDefault ? null : normalized;
}

/**
 * The CSS that applies a crop to an `<img>` filling a fixed frame. Every
 * surface uses this one string so the admin's preview is the render.
 *
 * `object-position` moves the focal point within a `cover` fit; the transform
 * magnifies about that same point, so zooming keeps whatever the admin
 * centered centered. An image with no crop gets no declarations at all rather
 * than the equivalent defaults, so nothing about its current rendering can
 * shift.
 */
export function galleryCropStyle(crop: unknown): string {
  const normalized = normalizeGalleryCrop(crop);
  if (!normalized) return '';
  const { x, y, scale } = normalized;
  const position = `object-position: ${x}% ${y}%;`;
  if (!scale || scale === 1) return position;
  return `${position} transform-origin: ${x}% ${y}%; transform: scale(${scale});`;
}
