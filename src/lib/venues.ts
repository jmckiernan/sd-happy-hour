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
export const vibeImages: Record<string, string> = {
  'Upscale casual': 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b',
  'Speakeasy': 'https://images.unsplash.com/photo-1470337458703-46ad1756a187',
  'Trendy gastropub': 'https://images.unsplash.com/photo-1538488881038-e252a119ace7',
  'Seafood spot': 'https://images.unsplash.com/photo-1559339352-11d035aa65de',
  'Rooftop vibes': 'https://images.unsplash.com/photo-1517457373958-b7bdd4587205',
  'Modern Mexican': 'https://images.unsplash.com/photo-1582169296194-e4d644c48063',
  'Tiki bar': 'https://images.unsplash.com/photo-1536935338788-846bb9981813',
  'Chef-driven': 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c',
  'Wine bar': 'https://images.unsplash.com/photo-1510812431401-41d2bd2722f3',
  'Upscale Mediterranean': 'https://images.unsplash.com/photo-1544148103-0773bf10d330',
  'Neighborhood gastropub': 'https://images.unsplash.com/photo-1575037614876-c38a4d44f5b8',
  'Craft cocktails': 'https://images.unsplash.com/photo-1551024709-8f23befc6f87',
  'Dog-friendly patio': 'https://images.unsplash.com/photo-1466978913421-dad2ebd01d17',
  'Casual chicken joint': 'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58',
  'Waterfront Mexican': 'https://images.unsplash.com/photo-1552566626-52f8b828add9',
  'Arcade bar': 'https://images.unsplash.com/photo-1511882150382-421056c89033',
  'All-day cafe': 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085',
  'Italian gastropub': 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4',
  'Vegan metal bar': 'https://images.unsplash.com/photo-1572116469696-31de0f17cc34',
  'Beach brewery': 'https://images.unsplash.com/photo-1559526324-593bc073d938',
  'default': 'https://images.unsplash.com/photo-1470337458703-46ad1756a187',
};

/**
 * Returns the Unsplash URL for a venue's vibe, sized for the given use.
 * 'card'  -> small homepage thumbnail (800px wide)
 * 'hero'  -> large venue-page banner (1600px wide, higher quality)
 */
export function getVenueImage(vibe: string, size: 'card' | 'hero' = 'card'): string {
  const base = vibeImages[vibe] || vibeImages['default'];
  return size === 'hero' ? `${base}?w=1600&q=85` : `${base}?w=800&q=80`;
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
