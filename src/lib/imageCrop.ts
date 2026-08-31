// Non-destructive framing for a venue's featured image.
//
// That one photo (`Venue.image`) is shown in a fixed frame on every surface
// that lists the venue — a wide hero on its own page, a squat card on the
// homepage, a near-square tile on the neighborhood index — and a `cover` fit
// decides for itself what to keep. When it guesses wrong the storefront sign
// or the patio ends up outside the frame, so an admin picks the focal point
// here instead.
//
// It is stored, not baked in: the file keeps whatever an admin uploaded, the
// choice stays re-editable, and one source can be framed differently at each
// ratio. Menu flyers in `galleryImages` deliberately have no equivalent —
// cropping a menu hides menu items, so those are shown whole and the visitor
// zooms instead.
//
// Client-safe by design: the admin form builder (lib/listingForm.ts) and the
// card renderers in index.astro and live-deals.astro all import it, so it must
// stay free of server imports.

export interface ImageCrop {
  /** Focal point across the image, 0 (left) to 100 (right). */
  x: number;
  /** Focal point down the image, 0 (top) to 100 (bottom). */
  y: number;
  /** Magnification about the focal point. 1 means the whole frame-filling
   * image, which is what an image with no crop already does. */
  scale?: number;
}

export const DEFAULT_IMAGE_CROP: Required<ImageCrop> = { x: 50, y: 50, scale: 1 };
export const MAX_IMAGE_CROP_SCALE = 4;

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isScale(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 1 && value <= MAX_IMAGE_CROP_SCALE;
}

/** Shape check for a stored `imageCrop`, matching the rule
 * scripts/validate-data.js enforces on the committed file. `scale` is optional
 * so the common "just move it" adjustment stores two numbers rather than
 * three. */
export function isImageCrop(value: unknown): value is ImageCrop {
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
 * image the way it has always rendered", which is what keeps every venue
 * nobody has framed looking identical.
 */
export function normalizeImageCrop(value: unknown): ImageCrop | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const crop = value as Record<string, unknown>;
  const x = Number(crop.x);
  const y = Number(crop.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const rawScale = crop.scale === undefined || crop.scale === null ? 1 : Number(crop.scale);
  const scale = Number.isFinite(rawScale) ? clamp(rawScale, 1, MAX_IMAGE_CROP_SCALE) : 1;
  const normalized: ImageCrop = { x: round(clamp(x, 0, 100)), y: round(clamp(y, 0, 100)) };
  if (scale > 1) normalized.scale = round(scale);

  const isDefault = normalized.x === DEFAULT_IMAGE_CROP.x
    && normalized.y === DEFAULT_IMAGE_CROP.y
    && normalized.scale === undefined;
  return isDefault ? null : normalized;
}

/**
 * The CSS that applies a crop to an `<img>` filling a fixed frame. Every
 * surface uses this one string so the admin's preview is the render.
 *
 * `object-position` moves the focal point within a `cover` fit; the transform
 * magnifies about that same point, so zooming keeps whatever the admin
 * centered centered. The magnification is also published as a custom property
 * so a surface with its own transform — the homepage card grows its photo on
 * hover — can compose with it rather than being overridden by the inline one.
 *
 * An image with no crop gets no declarations at all rather than the equivalent
 * defaults, so nothing about its current rendering can shift.
 */
export function imageCropStyle(crop: unknown): string {
  const normalized = normalizeImageCrop(crop);
  if (!normalized) return '';
  const { x, y, scale } = normalized;
  const position = `object-position: ${x}% ${y}%;`;
  if (!scale || scale === 1) return position;
  return `${position} --image-crop-scale: ${scale}; transform-origin: ${x}% ${y}%; transform: scale(${scale});`;
}

/**
 * The crop CSS for a listing, or nothing when it has no featured photo of its
 * own. A venue falling back to its vibe stock photo is showing an image the
 * admin never framed, so the framing must not follow it there.
 */
export function listingImageStyle(listing: { image?: string; imageCrop?: unknown } | null | undefined): string {
  if (!listing?.image) return '';
  return imageCropStyle(listing.imageCrop);
}
