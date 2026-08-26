import happyHours from '../../public/data/happy-hours.json';
import { vibeImageFor } from './vibeImages';
import type { AlertFilters, LiveOverride } from './store';
import { isHappyHourActive } from './sanDiegoTime';

export {
  getActiveHappyHourOccurrence,
  isHappyHourActive,
} from './sanDiegoTime';

export interface Venue {
  id: number;
  name: string;
  neighborhood: string;
  address: string;
  lat: number;
  lng: number;
  days: string[];
  /** General venue hours. Optional for legacy listings until an owner/admin
   * supplies them; these are distinct from the recurring happy-hour window. */
  openTime?: string;
  closeTime?: string;
  startTime: string;
  endTime: string;
  deals: string[];
  vibe: string;
  website: string;
  verified: boolean;
  /** Keep known test or incomplete listings available to product QA without
   * allowing them into search indexes or neighborhood discovery pages. */
  seoHidden?: boolean;
  // Optional metadata captured on submissions (src/pages/submit.astro) and
  // shown in the admin review queue. Older/seed venues won't have these.
  sourceUrl?: string;
  lastVerifiedAt?: string | null;
  dealTypes?: string[];
  features?: string[];
  // The venue's own listed phone number, independently sourced (not
  // self-reported by a claimant) — backs phone-based claim verification
  // (see api/restaurant/claim/send-code.ts). Absent on venues nobody has
  // looked up a number for yet; phone verification just isn't offered for
  // those, falling back to domain-match/manual review.
  phone?: string;
  // Admin-chosen featured photo, overriding the vibe stock photo everywhere
  // this venue is shown. Set in the submission review queue or the venue
  // editor; see getListingImage() for the fallback chain.
  image?: string;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function getVenues(): Venue[] {
  return happyHours as Venue[];
}

export function getVenueById(id: number): Venue | undefined {
  return getVenues().find((venue) => venue.id === id);
}

export function getVenueBySlug(slug: string): Venue | undefined {
  return getVenues().find((v) => slugify(v.name) === slug);
}

/**
 * Does this venue satisfy a saved alert's filters? Every set filter must
 * match (unset/empty filters are ignored) — same semantics as the homepage
 * filter bar (src/pages/index.astro getFilteredData()), so a "this alert
 * currently matches N spots" preview stays consistent with what the
 * homepage would show for the same filters. Also the basis for the future
 * live-happy-hour matching/notification engine (see the alerts spec).
 */
/** Is this venue within its scheduled happy-hour window right now, in San
 * Diego local time? Ignores manual live overrides — see isVenueLive() for
 * the legacy combined check. Kept as a compatibility name while consumers
 * move to isHappyHourActive()/getActiveHappyHourOccurrence(). */
export function isHappeningNow(venue: Venue, now: Date = new Date()): boolean {
  return isHappyHourActive(venue, now);
}

/** Is this venue live right now — either by its normal schedule, or because
 * a restaurant tapped "we're live now" (src/pages/api/restaurant/live.ts)
 * and the override hasn't expired? This is the check the notification
 * dispatch job and the public /api/live-status endpoint use. */
export function isVenueLive(venue: Venue, overrides: Record<number, LiveOverride>, now: Date = new Date()): boolean {
  const override = overrides[venue.id];
  if (override?.active && new Date(override.expiresAt).getTime() > now.getTime()) return true;
  return isHappeningNow(venue, now);
}

export function alertMatchesVenue(filters: AlertFilters, venue: Venue): boolean {
  if (filters.days?.length && !filters.days.some((day) => venue.days.includes(day))) return false;
  if (filters.neighborhood && venue.neighborhood !== filters.neighborhood) return false;
  if (filters.dealType && !(venue.dealTypes || []).includes(filters.dealType)) return false;
  if (filters.feature && !(venue.features || []).includes(filters.feature)) return false;
  if (filters.query) {
    const haystack = [venue.name, venue.neighborhood, venue.address, venue.vibe, ...(venue.deals || []), ...(venue.dealTypes || []), ...(venue.features || [])]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filters.query.toLowerCase())) return false;
  }
  return true;
}

export function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

// Re-exported from lib/vibeImages.ts, where the map itself now lives so the
// admin listing form can share it without dragging this module (and the venue
// dataset it imports) into a browser bundle.
export { vibeImages, vibeImageFor } from './vibeImages';

const IMAGE_SIZES = {
  card: { w: 800, q: 80 },
  hero: { w: 1600, q: 85 },
} as const;

/**
 * Routes an image through Netlify Image CDN at the requested size, which
 * resizes on demand and negotiates a modern format (AVIF/WebP), edge-caching
 * each distinct transform. For the vibe photos that's a like-for-like
 * replacement for the `?w=`/`?q=` params Unsplash used to handle, so only one
 * 1600px master per vibe has to be committed rather than a variant per size.
 *
 * Left alone in three cases:
 *
 * - Outside production. `/.netlify/images` only exists on Netlify's platform;
 *   plain `astro dev` 404s it, so dev serves the original. Unoptimized, but it
 *   renders. `npm run dev:netlify` exercises the real path — same dev/prod
 *   split as lib/imageStore.ts.
 * - Anything not rooted at `/`. Remote sources need a `remote_images`
 *   allowlist in netlify.toml, and a post's heroImage can be any URL an admin
 *   pasted, so those pass through untouched rather than 400ing.
 * - Blob-backed uploads at `/api/images/` — served by a server function, not
 *   a static file Netlify Image CDN can fetch — so those stay direct too.
 * - Already-transformed URLs, so wrapping twice is a no-op.
 */
function throughImageCdn(src: string, size: 'card' | 'hero'): string {
  if (!import.meta.env.PROD) return src;
  if (!src.startsWith('/') || src.startsWith('/.netlify/images')) return src;
  if (src.startsWith('/api/images/')) return src;
  const { w, q } = IMAGE_SIZES[size];
  return `/.netlify/images?url=${encodeURIComponent(src)}&w=${w}&q=${q}`;
}

/**
 * Returns the URL for a venue's vibe photo, sized for the given use.
 * 'card'  -> small homepage thumbnail (800px wide)
 * 'hero'  -> large venue-page banner (1600px wide, higher quality)
 */
export function getVenueImage(vibe: string, size: 'card' | 'hero' = 'card'): string {
  return throughImageCdn(vibeImageFor(vibe), size);
}

/**
 * The image to show for a venue: its own admin-set featured photo if it has
 * one, otherwise the vibe stock photo. Every surface that shows a venue photo
 * (homepage cards, venue hero, OG image) goes through this, so setting a
 * featured image in the admin updates all of them at once and clearing it
 * falls straight back to the stock photo.
 *
 * Takes a venue-shaped object rather than a Venue so the homepage's client
 * script — which works off parsed happy-hours.json, not the typed import —
 * can call it too.
 */
export function getListingImage(
  venue: { image?: string; vibe?: string },
  size: 'card' | 'hero' = 'card'
): string {
  // Featured photos are usually full-size originals served from Blobs via
  // /api/images/, so they need the same Image CDN pass the vibe photos get —
  // otherwise a card thumbnail downloads a hero-resolution file.
  if (venue.image) return throughImageCdn(venue.image, size);
  return getVenueImage(venue.vibe || '', size);
}

/**
 * Picks an image for a blog post: the post's own heroImage if set, else the
 * vibe photo of the first venue it mentions, else a generic default — so
 * every post gets a thumbnail/hero even before a real photo is uploaded.
 */
export function getPostImage(
  heroImage: string | undefined,
  venueSlugs: string[] = [],
  size: 'card' | 'hero' = 'card'
): string {
  // Hero images are whatever the admin generated or uploaded — typically a
  // full-size AI PNG served from Blobs via /api/images/. Sending those
  // through Image CDN too means the blog index isn't loading hero-resolution
  // originals into thumbnail slots.
  if (heroImage) return throughImageCdn(heroImage, size);
  const firstVenue = venueSlugs.map(getVenueBySlug).find((v): v is Venue => Boolean(v));
  return getVenueImage(firstVenue?.vibe || '', size);
}

/** Fallback when a post's primary image 404s — reuse the stored hero URL, not a vibe stock photo. */
export function getPostImageFallback(
  heroImage: string | undefined,
  venueSlugs: string[] = [],
  size: 'card' | 'hero' = 'card'
): string {
  if (heroImage) return heroImage;
  return getPostImage(undefined, venueSlugs, size);
}
