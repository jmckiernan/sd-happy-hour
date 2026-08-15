import happyHours from '../../public/data/happy-hours.json';
import type { AlertFilters, LiveOverride } from './store';

export interface Venue {
  id: number;
  name: string;
  neighborhood: string;
  address: string;
  lat: number;
  lng: number;
  days: string[];
  startTime: string;
  endTime: string;
  deals: string[];
  vibe: string;
  website: string;
  verified: boolean;
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
const SD_TIME_ZONE = 'America/Los_Angeles';

/** Breaks a Date down into San Diego-local weekday + minutes-since-midnight,
 * regardless of what timezone the code is actually running in. The
 * homepage's own isHappeningNow() (src/pages/index.astro) uses the
 * visitor's browser clock instead, which is fine for a mostly-local
 * audience checking on their phone — but this server-side version backs
 * the notification dispatch job (lib/notify.ts), which runs on whatever
 * timezone the server happens to be in, so it has to pin to Pacific
 * explicitly rather than trust the runtime's local clock. */
function pacificParts(now: Date): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SD_TIME_ZONE,
    weekday: 'long',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '0';
  const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
  return { weekday, minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')) };
}

/** Is this venue within its scheduled happy-hour window right now, in San
 * Diego local time? Ignores manual live overrides — see isVenueLive() for
 * the combined check used everywhere that matters (matching, live badges). */
export function isHappeningNow(venue: Venue, now: Date = new Date()): boolean {
  const { weekday, minutes } = pacificParts(now);
  if (!venue.days.includes(weekday)) return false;
  const [sh, sm] = venue.startTime.split(':').map(Number);
  const [eh, em] = venue.endTime.split(':').map(Number);
  return minutes >= sh * 60 + sm && minutes <= eh * 60 + em;
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

// Stock photo per "vibe" — used as a thumbnail on the homepage cards and,
// at a higher resolution, as the hero banner on individual venue pages.
//
// These used to be hotlinks to images.unsplash.com, which meant every page
// load depended on Unsplash staying up and keeping those photo IDs alive
// (and rendered as broken images anywhere Unsplash is network-blocked).
// They're now our own copies under public/images/vibes/, downloaded once by
// scripts/fetch-vibe-images.js — which is also where the original Unsplash
// photo IDs are recorded, if one ever needs re-fetching.
//
// Each file is a single 1600px-wide master (the largest size the site asks
// for). The card/hero sizing that Unsplash's `?w=` params used to do now
// happens in getVenueImage() below.
export const vibeImages: Record<string, string> = {
  'Upscale casual': '/images/vibes/upscale-casual.jpg',
  'Speakeasy': '/images/vibes/speakeasy.jpg',
  'Trendy gastropub': '/images/vibes/trendy-gastropub.jpg',
  'Seafood spot': '/images/vibes/seafood-spot.jpg',
  'Rooftop vibes': '/images/vibes/rooftop-vibes.jpg',
  'Modern Mexican': '/images/vibes/modern-mexican.jpg',
  'Tiki bar': '/images/vibes/tiki-bar.jpg',
  'Chef-driven': '/images/vibes/chef-driven.jpg',
  'Wine bar': '/images/vibes/wine-bar.jpg',
  'Upscale Mediterranean': '/images/vibes/upscale-mediterranean.jpg',
  'Neighborhood gastropub': '/images/vibes/neighborhood-gastropub.jpg',
  'Craft cocktails': '/images/vibes/craft-cocktails.jpg',
  'Dog-friendly patio': '/images/vibes/dog-friendly-patio.jpg',
  'Casual chicken joint': '/images/vibes/casual-chicken-joint.jpg',
  'Waterfront Mexican': '/images/vibes/waterfront-mexican.jpg',
  'Arcade bar': '/images/vibes/arcade-bar.jpg',
  'All-day cafe': '/images/vibes/all-day-cafe.jpg',
  'Italian gastropub': '/images/vibes/italian-gastropub.jpg',
  'Vegan metal bar': '/images/vibes/vegan-metal-bar.jpg',
  'Beach brewery': '/images/vibes/beach-brewery.jpg',
  // Intentionally the same photo as 'Speakeasy' — that's what the previous
  // Unsplash map did too (both pointed at photo-1470337458703).
  'default': '/images/vibes/speakeasy.jpg',
};

const IMAGE_SIZES = {
  card: { w: 800, q: 80 },
  hero: { w: 1600, q: 85 },
} as const;

/**
 * Returns the URL for a venue's vibe photo, sized for the given use.
 * 'card'  -> small homepage thumbnail (800px wide)
 * 'hero'  -> large venue-page banner (1600px wide, higher quality)
 *
 * In production this routes through Netlify Image CDN, which resizes the
 * 1600px master on demand and negotiates a modern format (AVIF/WebP), then
 * edge-caches each distinct transform. That's a like-for-like replacement
 * for the `?w=`/`?q=` params Unsplash used to handle, so only one file per
 * vibe has to be committed rather than a pre-sized variant per size.
 *
 * `/.netlify/images` only exists on Netlify's platform, though — plain
 * `astro dev` would 404 it — so in dev this serves the master file
 * directly. Unoptimized, but it renders. `npm run dev:netlify` exercises
 * the real Image CDN path, same dev/prod split as lib/imageStore.ts.
 */
export function getVenueImage(vibe: string, size: 'card' | 'hero' = 'card'): string {
  const base = vibeImages[vibe] || vibeImages['default'];
  if (!import.meta.env.PROD) return base;
  const { w, q } = IMAGE_SIZES[size];
  return `/.netlify/images?url=${encodeURIComponent(base)}&w=${w}&q=${q}`;
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
  if (heroImage) return heroImage;
  const firstVenue = venueSlugs.map(getVenueBySlug).find((v): v is Venue => Boolean(v));
  return getVenueImage(firstVenue?.vibe || '', size);
}
