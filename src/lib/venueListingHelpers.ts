// Pure listing helpers safe for browser bundles — no happy-hours.json import.
// Server code re-exports these from lib/venues.ts; client scripts import here
// directly so Vite never inlines the venue catalog into homepage JS.

import { OFFERS_UNKNOWN_FILTER } from './directoryFilters';
import { vibeImageFor } from './vibeImages';
import { slugFromMap, type SlugVenue } from './venueSlug';

export interface VenueAlertFilters {
  days?: string[];
  neighborhood?: string;
  dealType?: string;
  query?: string;
  startTime?: string;
  endTime?: string;
}

type AlertMatchVenue = SlugVenue & {
  days?: string[];
  dealTypes?: string[];
  vibe?: string;
  deals?: string[];
  startTime?: string;
  endTime?: string;
  windows?: Array<{ startTime?: string; endTime?: string; days?: string[] }>;
};

const IMAGE_SIZES = {
  tile: { w: 640, q: 80 },
  card: { w: 800, q: 80 },
  hero: { w: 1600, q: 85 },
} as const;

/** Netlify Image CDN transform — shared with lib/listingForm previewSrc. */
export function throughImageCdn(src: string, size: keyof typeof IMAGE_SIZES): string {
  if (!import.meta.env.PROD) return src;
  if (!src.startsWith('/') || src.startsWith('/.netlify/images')) return src;
  if (src.startsWith('/api/images/')) return src;
  const { w, q } = IMAGE_SIZES[size];
  return `/.netlify/images?url=${encodeURIComponent(src)}&w=${w}&q=${q}`;
}

export function getVenueImage(vibe: string | undefined, size: 'card' | 'hero' = 'card'): string {
  return throughImageCdn(vibeImageFor(vibe), size);
}

export function getGalleryThumb(url: string): string {
  return throughImageCdn(url, 'tile');
}

export function getListingImage(
  venue: { image?: string; vibe?: string },
  size: 'card' | 'hero' = 'card',
): string {
  if (venue.image) return throughImageCdn(venue.image, size);
  return getVenueImage(venue.vibe || '', size);
}

export function venueListingPath(venue: SlugVenue, slugs: Map<number, string>): string {
  return `/venues/${slugFromMap(venue, slugs)}/`;
}

function clockMinutes(value: string | undefined): number | null {
  if (!value || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function venueMatchesTimeRange(
  venue: Pick<AlertMatchVenue, 'startTime' | 'endTime' | 'windows'>,
  startTime = '',
  endTime = '',
  days: string[] = [],
): boolean {
  const lower = clockMinutes(startTime);
  const upper = clockMinutes(endTime);
  if (lower === null && upper === null) return true;

  const windows = venue.windows?.length
    ? venue.windows
    : venue.startTime && venue.endTime
      ? [{ startTime: venue.startTime, endTime: venue.endTime }]
      : [];

  return windows.some((window) => {
    if (days.length && 'days' in window && window.days?.length && !days.some((day) => (window.days || []).includes(day))) {
      return false;
    }
    const rawStart = clockMinutes(window.startTime);
    const rawEnd = clockMinutes(window.endTime);
    if (rawStart === null || rawEnd === null) return false;
    const windowEnd = rawEnd <= rawStart ? rawEnd + 24 * 60 : rawEnd;

    if (lower !== null && upper !== null) {
      const filterEnd = upper <= lower ? upper + 24 * 60 : upper;
      return [-24 * 60, 0, 24 * 60].some((shift) =>
        rawStart >= lower + shift && windowEnd <= filterEnd + shift
      );
    }
    if (lower !== null) return rawStart >= lower;
    return rawEnd <= upper!;
  });
}

export type VenueVerificationType = 'owner' | 'web' | 'none';

export function venueVerificationType(
  venue: {
    verified?: boolean;
    lastVerifiedAt?: string | null;
    hhSources?: Record<string, { source?: string } | undefined>;
  },
  ownerVerified = false,
): VenueVerificationType {
  if (ownerVerified) return 'owner';
  const hasWebEvidence = Object.values(venue.hhSources || {}).some((source) => {
    const kind = String(source?.source || '').toLowerCase();
    return kind.includes('website') || kind.includes('google') || kind.includes('venue');
  });
  return venue.verified || Boolean(venue.lastVerifiedAt) || hasWebEvidence ? 'web' : 'none';
}

export function alertMatchesVenue(filters: VenueAlertFilters, venue: AlertMatchVenue): boolean {
  const venueDays = venue.days || [];
  if (filters.days?.length && !filters.days.some((day) => venueDays.includes(day))) return false;
  if (filters.neighborhood && venue.neighborhood !== filters.neighborhood) return false;
  if (filters.dealType === OFFERS_UNKNOWN_FILTER) {
    if ((venue.dealTypes || []).length) return false;
  } else if (filters.dealType && !(venue.dealTypes || []).includes(filters.dealType)) {
    return false;
  }
  if (filters.query) {
    const haystack = [venue.name, venue.neighborhood, venue.address, venue.vibe, ...(venue.deals || []), ...(venue.dealTypes || [])]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filters.query.toLowerCase())) return false;
  }
  if (!venueMatchesTimeRange(venue, filters.startTime, filters.endTime, filters.days)) return false;
  return true;
}
