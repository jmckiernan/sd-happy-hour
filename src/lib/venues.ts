import happyHours from '../../public/data/happy-hours.json';
import { isPubliclyListed, type BrowseHold } from './listingVisibility';
import { vibeImageFor } from './vibeImages';
import type { AlertFilters, LiveOverride } from './store';
import { isHappyHourActive } from './sanDiegoTime';
import { DEALS_UNKNOWN_LABEL } from './listingCopy';
import { OFFERS_UNKNOWN_FILTER } from './directoryFilters';
import type { WeeklySpecial } from './listingCopy';
import { slugify, buildVenueSlugMap, slugFromMap, type SlugVenue } from './venueSlug';
import type { ImageFraming } from './imageCrop';

export { slugify };

export {
  getActiveHappyHourOccurrence,
  isHappyHourActive,
} from './sanDiegoTime';

export { DEALS_UNKNOWN_LABEL };
export type { WeeklySpecial };

/**
 * One photo in a venue's gallery, usually a happy-hour menu flyer.
 *
 * Named rather than inlined on Venue so the submission and admin validators can
 * state that they produce exactly this, instead of a loose record that happens
 * to line up.
 */
export interface GalleryImage {
  url: string;
  caption?: string;
  sourceUrl?: string | null;
  /** Rendered by us from `hhMenu`, not scraped from the venue. */
  generated?: boolean;
}

export interface Venue {
  id: number;
  name: string;
  neighborhood: string;
  address: string;
  lat: number;
  lng: number;
  /** Absent on stub listings, which we carry only so an owner can find and
   * claim them. Public browse surfaces get ListedVenue, where the window is
   * guaranteed, so only the venue page and the claim search see them missing. */
  days?: string[];
  /** General venue hours. Optional for legacy listings until an owner/admin
   * supplies them; these are distinct from the recurring happy-hour window. */
  openTime?: string;
  closeTime?: string;
  startTime?: string;
  endTime?: string;
  deals: string[];
  /** Day-by-day specials that don't fit a single happy-hour window (named nights, exchanges, game day). */
  weeklySpecials?: WeeklySpecial[];
  /**
   * What kind of place this is — brewery, sports bar, rooftop bar, pub — from
   * the closed vocabulary in scripts/import-google-venues/lib/venue-kind.mjs,
   * or whatever an owner typed into the claim form.
   *
   * Absent on most listings, and that is the point. It used to be required, so
   * every row carried one of eight labels derived from Google's whole `types`
   * array: `Restaurant` on a third of the catalog, and `Cocktail bar` on 506
   * rows of which 17 were cocktail bars. Surfaces show it where it exists and
   * show nothing where it does not, rather than printing a guess.
   */
  vibe?: string;
  website: string;
  verified: boolean;
  /**
   * Keep a listing out of search engines, and nothing else: `noindex` on its
   * page, out of the sitemap, and out of the homepage's ItemList structured
   * data.
   *
   * It is not a navigation flag. Reading it as one is what made 83 published
   * venues unreachable, so browse visibility now has its own field that
   * records why — see `browseHold`.
   */
  seoHidden?: boolean;
  /**
   * Why this venue is held back from browse surfaces, or absent when it is
   * not. The reasons and the surfaces that honour them live in
   * src/lib/listingVisibility.ts.
   */
  browseHold?: BrowseHold | null;
  /**
   * Whether this venue reaches public browse surfaces. Every establishment we
   * know about stays in the dataset so owners can find and claim it — even
   * ones with no happy hour at all — but only 'published' listings appear in
   * search, the homepage, and neighborhood pages. See
   * scripts/backfill-google-happy-hour.mjs for how this is assigned.
   */
  listingStatus?: 'published' | 'unlisted';
  /** Published because an owner claimed and verified it, not because the data
   * pipeline could substantiate it. Keeps a later backfill from re-hiding it. */
  publishedByClaim?: boolean;
  /** Do we have a happy-hour window we can actually stand behind? */
  hasHappyHourData?: boolean;
  /** We know when happy hour runs, but no source published the offers. */
  dealsUnknown?: boolean;
  /** Canonical schedule: one entry per distinct period (afternoon, late-night, weekday special).
   * startTime/endTime/days stay populated as the primary window for older UI. */
  windows?: {
    days: string[];
    startTime: string;
    endTime: string;
    kind?: 'happy_hour' | 'late_night' | 'weekly_special';
    label?: string;
    location?: string;
    allDay?: boolean;
    /** Happy hour runs from opening, so startTime is for filtering only and
     * must never be displayed — show "Open until <end>" instead. */
    startsAtOpen?: boolean;
  }[];
  /**
   * Structured happy-hour menu, when the venue publishes one as HTML rather
   * than a flyer we can reuse. Source of truth for the menu board images we
   * typeset ourselves; `npm run menus:render` rebuilds them from this.
   */
  hhMenu?: {
    note?: string;
    sections: {
      title: string;
      items: {
        name: string;
        /** Exactly as the venue printed it. The string we display. */
        price?: string;
        /**
         * What `price` means. A happy hour is published either as a figure the
         * item costs or as a reduction off the regular price, and both are
         * complete offers — so the discount is recorded as a discount instead
         * of "$2 off" sitting in a field that reads as $2.
         *
         * Absent when the printed text fits no kind cleanly. Never infer
         * across kinds: the regular price is unknown, so a discount yields no
         * absolute figure and an absolute figure yields no saving.
         */
        offer?:
          | { kind: 'absolute'; amount?: number }
          | { kind: 'amount_off'; amountOff?: number }
          | { kind: 'percent_off'; percentOff?: number }
          | { kind: 'range'; min?: number; max?: number }
          | { kind: 'multi'; amounts?: number[] }
          | {
              kind: 'bundle';
              quantity?: number;
              amount?: number;
              forQuantity?: number;
              freeQuantity?: number;
            };
        /**
         * Coarse kind of offer, supplied by the transcription pass because it
         * can read the whole menu. Only used to categorize the item in the
         * database; never displayed on the board.
         */
        category?: string;
      }[];
    }[];
    sourceUrl?: string | null;
    observedAt?: string;
    /** Built from the directory chips because no real menu was published. */
    fromDealChips?: boolean;
    /**
     * The venue's own menu flyer, kept as evidence of where `sections` came
     * from so an extraction can be re-checked against the original. Provenance,
     * not presentation: these are deliberately not shown as the menu, because
     * an image cannot be searched, corrected, or read by anything downstream,
     * and one of them turned out to be a photo of brewery tanks.
     */
    sourceImages?: GalleryImage[];
  };
  /** Photos of the venue, shown in the photo gallery. */
  galleryImages?: GalleryImage[];
  /**
   * Images that ranked as a happy-hour menu but that no transcription pass has
   * confirmed, so we cannot say they are menus. Held for a later attempt and
   * never displayed: ranking a URL is not evidence, and one of these turned out
   * to be a photograph of brewery tanks.
   */
  menuCandidateImages?: GalleryImage[];
  /** Last pipeline pass: found vs not-published vs blocked vs no candidates, with evidence. */
  lastScrape?: {
    outcome: string;
    found: boolean;
    reason: string;
    sourceUrl: string | null;
    candidateUrls: string[];
    evidence: { url: string; quote: string; field: string }[];
    locationApplicability?: string | null;
    confidence?: string | null;
    observedAt: string;
  };
  /** Where each field came from, so later runs can reason instead of guess. */
  hhSources?: Record<string, {
    source: string;
    url: string | null;
    observedAt: string | null;
    evidence?: { url: string; quote: string; field: string }[];
  }>;
  /** Sources that disagreed with what we published; a human-review signal. */
  hhConflicts?: { field: string; source: string; value: string }[];
  /** Google Place ID, when we've matched this venue to a cached place. */
  placeId?: string;
  // Optional metadata captured on submissions (src/pages/submit.astro) and
  // shown in the admin review queue. Older/seed venues won't have these.
  sourceUrl?: string;
  lastVerifiedAt?: string | null;
  dealTypes?: string[];
  /** Google Atmosphere `outdoorSeating` / `allowsDogs`, captured on an import
   * run rather than inferred from anything.
   *
   * Optional on purpose, and the three states are all distinct: `true` means
   * Google says the venue has it, `false` means Google says it does not, and
   * an absent key means nobody has told us either way. Collapsing that absence
   * into `false` is what made the old `features` array useless — a venue with
   * no `patio` tag was indistinguishable from a venue nobody had asked about
   * (docs/features-field-experiment.md §7). Anything reading these has to
   * treat `undefined` as unknown and say nothing rather than say no. */
  outdoorSeating?: boolean;
  allowsDogs?: boolean;
  /** The rest of the Atmosphere set bought in the same run, same three-state
   * rule: `true` yes, `false` no, absent means Google never answered. Fill
   * rates are recorded in docs/places-api-cost-analysis.md §5 — `allowsDogs`
   * is only 39%, so treating absence as `false` would invent a dog ban for
   * 1,694 venues. Rendering goes through src/lib/venueAttributes.ts, which
   * shows a fact only when it is `true`. */
  reservable?: boolean;
  liveMusic?: boolean;
  restroom?: boolean;
  goodForGroups?: boolean;
  goodForWatchingSports?: boolean;
  servesVegetarianFood?: boolean;
  /** Google's grouped booleans. A missing sub-key is unknown, not false, so
   * these are partial objects rather than complete records. */
  parkingOptions?: Record<string, boolean>;
  paymentOptions?: Record<string, boolean>;
  accessibilityOptions?: Record<string, boolean>;
  /** `PRICE_LEVEL_MODERATE` and friends. */
  priceLevel?: string;
  /** Google's per-person spend range, only stored when both ends are known. */
  priceRange?: { startPrice: number; endPrice: number; currencyCode: string };
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
  /** Which part of `image` each fixed frame shows — the hero, the card and the
   * neighborhood tile are framed separately — set by an admin in the venue
   * editor. An absent frame means centered and unmagnified, how every featured
   * photo was framed before this existed. The file is never re-cropped; see
   * lib/imageCrop.ts. */
  imageCrop?: ImageFraming;
}

let slugsById: Map<number, string> | null = null;

function slugIndex(): Map<number, string> {
  if (!slugsById) slugsById = buildVenueSlugMap(getVenues());
  return slugsById;
}

/** Public URL slug for a listing. Location is appended when the name is shared. */
export function venueSlug(venue: SlugVenue): string {
  return slugFromMap(venue, slugIndex());
}

export function venuePath(venue: SlugVenue): string {
  return `/venues/${venueSlug(venue)}/`;
}

export function getVenues(): Venue[] {
  return happyHours as Venue[];
}

/**
 * Unlisted venues still exist for claiming, admin, and direct links — they're
 * just kept out of browse and discovery surfaces so we never advertise a happy
 * hour we can't substantiate. A domain/phone self-verify or an admin-approved
 * manual claim overrides that: see lib/listingVisibility.ts.
 */
export { isPubliclyListed };

/**
 * A venue with a happy-hour window we can actually show. Everything that
 * renders a time, sorts by one, or answers "is it on right now" wants this
 * rather than Venue, so stub listings can't reach those paths untyped.
 */
export type ListedVenue = Venue & {
  days: string[];
  startTime: string;
  endTime: string;
};

/**
 * A claim can publish a stub listing before its owner has told us when happy
 * hour runs, so this is checked alongside listing status rather than assumed
 * from it — such a venue stays off browse until there is a window to show.
 */
export function hasSchedule(venue: Venue): venue is ListedVenue {
  return Boolean(venue.startTime && venue.endTime && venue.days?.length);
}

/**
 * Venues that should appear in search, the homepage, and neighborhood pages.
 *
 * Build-time callers (prerendered pages, the sitemap) can't know about claims
 * verified since the last deploy, so they pass nothing and get the static
 * answer; those surfaces catch up on the deploy that publishVerifiedVenue()
 * triggers. Runtime callers pass the publication set for the live answer.
 */
export function getPublicVenues(publishedVenueIds?: ReadonlySet<number> | null): ListedVenue[] {
  return getVenues().filter(
    (venue): venue is ListedVenue =>
      hasSchedule(venue) && isPubliclyListed(venue, publishedVenueIds)
  );
}

export function getVenueById(id: number): Venue | undefined {
  return getVenues().find((venue) => venue.id === id);
}

/** Blog posts render venue cards, which show a happy-hour window, so a stub
 * listing can never be the answer here even when its name matches the slug. */
export function getVenuesForBlogSlug(slug: string): ListedVenue[] {
  const venues = getVenues().filter(hasSchedule);
  const exact = venues.filter((venue) => venueSlug(venue) === slug);
  if (exact.length) return exact;
  return venues.filter((venue) => slugify(venue.name) === slug);
}

export function getVenueBySlug(slug: string): ListedVenue | undefined {
  const matches = getVenuesForBlogSlug(slug);
  if (matches.length === 1) return matches[0];
  return matches.find((venue) => venueSlug(venue) === slug);
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
  return hasSchedule(venue) && isHappyHourActive(venue, now);
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
  // An alert saved from the homepage filter bar can carry that bar's one
  // non-deal-type option, which selects venues whose offers nobody published.
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
  return true;
}

export function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
}

export { WEEKDAY_NAMES, happyHourDayNames } from './happyHourDays';

// Re-exported from lib/vibeImages.ts, where the map itself now lives so the
// admin listing form can share it without dragging this module (and the venue
// dataset it imports) into a browser bundle.
export { vibeImages, vibeImageFor } from './vibeImages';

const IMAGE_SIZES = {
  tile: { w: 640, q: 80 },
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
function throughImageCdn(src: string, size: keyof typeof IMAGE_SIZES): string {
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
export function getVenueImage(vibe: string | undefined, size: 'card' | 'hero' = 'card'): string {
  return throughImageCdn(vibeImageFor(vibe), size);
}

/**
 * A gallery flyer sized for its thumbnail frame on the venue page. The
 * lightbox deliberately does not use this: a happy-hour menu is only readable
 * at full resolution, so zooming loads the original (see the venue page's
 * originalSrc()).
 */
export function getGalleryThumb(url: string): string {
  return throughImageCdn(url, 'tile');
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
  const firstVenue = venueSlugs.flatMap(getVenuesForBlogSlug)[0];
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
