// Non-destructive framing for a venue's featured image.
//
// That one photo (`Venue.image`) is shown in a fixed frame on every surface
// that lists the venue, and a `cover` fit decides for itself what to keep.
// When it guesses wrong the storefront sign or the patio ends up outside the
// frame, so an admin picks the focal point here instead.
//
// It is stored, not baked in: the file keeps whatever an admin uploaded, the
// choice stays re-editable, and one source is framed differently at each
// shape. Menu flyers in `galleryImages` deliberately have no equivalent —
// cropping a menu hides menu items, so those are shown whole and the visitor
// zooms instead.
//
// Client-safe by design: the admin form builder (lib/listingForm.ts) and the
// card renderers in index.astro and live-deals.astro all import it, so it must
// stay free of server imports.

/** Focal point and magnification for one frame. */
export interface ImageCrop {
  /** Focal point across the image, 0 (left) to 100 (right). */
  x: number;
  /** Focal point down the image, 0 (top) to 100 (bottom). */
  y: number;
  /** Magnification about the focal point. 1 means the whole frame-filling
   * image, which is what an image with no crop already does. */
  scale?: number;
}

/**
 * Framing is stored per frame, not once per venue, because the shapes disagree
 * about what matters: a wide hero wants the storefront off to one side, and
 * the square neighborhood tile wants that same sign dead centre or it loses it
 * entirely. One focal point cannot satisfy both, so each frame carries its own.
 *
 * Keyed by named surface rather than by aspect ratio. A ratio key ("5:2") reads
 * like the more general choice, but it is really a CSS measurement wearing a
 * data hat: restyling the card from 200px to 240px tall would silently re-key
 * every frame, orphaning framing that admins had already set and leaving no way
 * to tell the orphan from a deliberate blank. A surface's name outlives its
 * proportions. It also lets two surfaces that happen to share a ratio today
 * diverge later without a migration, and reads better in the file.
 *
 * Adding a surface means adding a key here and passing it at the render site;
 * everything already stored keeps working, because an unframed key renders as
 * an unframed image always has.
 */
export const IMAGE_FRAMES = [
  { key: 'hero', label: 'Venue hero', ratio: '5 / 2', hint: 'Venue page' },
  { key: 'card', label: 'Card', ratio: '3 / 2', hint: 'Homepage, Live Deals, neighborhood pages' },
  { key: 'tile', label: 'Neighborhood tile', ratio: '1 / 1', hint: 'Neighborhood index' },
] as const;

export type ImageFrame = (typeof IMAGE_FRAMES)[number]['key'];

const FRAME_KEYS: readonly string[] = IMAGE_FRAMES.map((frame) => frame.key);

/** Every frame an admin has framed. Absent keys are not "centered", they are
 * "never touched", which is the same thing to render and a different thing to
 * an admin looking at the editor. */
export type ImageFraming = Partial<Record<ImageFrame, ImageCrop>>;

export const DEFAULT_IMAGE_CROP: Required<ImageCrop> = { x: 50, y: 50, scale: 1 };
export const MAX_IMAGE_CROP_SCALE = 4;

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isScale(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 1 && value <= MAX_IMAGE_CROP_SCALE;
}

/** Shape check for one frame's crop. `scale` is optional so the common
 * "just move it" adjustment stores two numbers rather than three. */
export function isImageCrop(value: unknown): value is ImageCrop {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const crop = value as Record<string, unknown>;
  if (!isPercent(crop.x) || !isPercent(crop.y)) return false;
  if ('scale' in crop && crop.scale !== undefined && !isScale(crop.scale)) return false;
  return true;
}

/** Shape check for a stored `imageCrop`, matching the rule
 * scripts/validate-data.js enforces on the committed file: known frame keys
 * only, each holding a valid crop, and at least one of them — an empty object
 * says nothing that an absent key doesn't. */
export function isImageFraming(value: unknown): value is ImageFraming {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return false;
  return entries.every(([frame, crop]) => FRAME_KEYS.includes(frame) && isImageCrop(crop));
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
 * One frame's crop coerced into range, or null when it is absent, unusable, or
 * says the same thing as no crop at all.
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
 * Stored framing coerced into range, or null when nothing is framed. Callers
 * treat null as "render this image the way it has always rendered", which is
 * what keeps every venue nobody has framed looking identical.
 *
 * A bare `{x, y, scale}` is read as one focal point shared by every frame.
 * That was the shape this shipped as for half an hour before framing became
 * per-frame; no venue was ever saved with it, but tolerating it costs three
 * lines and means an old row could never render as an unexplained crop.
 */
export function normalizeImageFraming(value: unknown): ImageFraming | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;

  if ('x' in source || 'y' in source) {
    const shared = normalizeImageCrop(source);
    if (!shared) return null;
    return Object.fromEntries(FRAME_KEYS.map((frame) => [frame, { ...shared }])) as ImageFraming;
  }

  const framing: ImageFraming = {};
  for (const frame of IMAGE_FRAMES) {
    const crop = normalizeImageCrop(source[frame.key]);
    if (crop) framing[frame.key] = crop;
  }
  return Object.keys(framing).length ? framing : null;
}

/**
 * The CSS that applies one frame's crop to an `<img>` filling it. Every
 * surface uses this one function so the admin's preview is the render.
 *
 * `object-position` moves the focal point within a `cover` fit; the transform
 * magnifies about that same point, so zooming keeps whatever the admin
 * centered centered. The magnification is also published as a custom property
 * so a surface with its own transform — the homepage card grows its photo on
 * hover — can compose with it rather than being overridden by the inline one.
 *
 * A frame with no crop gets no declarations at all rather than the equivalent
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

/** The CSS for one frame of a stored framing value. */
export function imageFramingStyle(framing: unknown, frame: ImageFrame): string {
  const normalized = normalizeImageFraming(framing);
  return normalized ? imageCropStyle(normalized[frame]) : '';
}

/**
 * The framing CSS for a listing in a given frame, or nothing when it has no
 * featured photo of its own. A venue falling back to its vibe stock photo is
 * showing an image the admin never framed, so the framing must not follow it
 * there.
 */
export function listingImageStyle(
  listing: { image?: string; imageCrop?: unknown } | null | undefined,
  frame: ImageFrame
): string {
  if (!listing?.image) return '';
  return imageFramingStyle(listing.imageCrop, frame);
}
