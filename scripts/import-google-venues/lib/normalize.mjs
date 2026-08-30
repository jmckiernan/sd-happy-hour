import { COUNTY_BOUNDS, DAY_NAMES, DEAL_TYPES, FEATURES } from './constants.mjs';
import { finalizeDeals } from './deals.mjs';
import { assignNeighborhood } from './neighborhood-assign.mjs';
import { isUsableVenueWebsite } from './website-ownership.mjs';

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function inCounty(lat, lng) {
  return lat >= COUNTY_BOUNDS.minLat && lat <= COUNTY_BOUNDS.maxLat
    && lng >= COUNTY_BOUNDS.minLng && lng <= COUNTY_BOUNDS.maxLng;
}

export function guessNeighborhood(lat, lng, formattedAddress = '') {
  return assignNeighborhood(lat, lng, formattedAddress);
}

function inferVibe(primaryType, types = []) {
  const joined = [primaryType, ...types].join(' ').toLowerCase();
  if (/wine_bar|winery/.test(joined)) return 'Wine bar';
  if (/brewery|brewpub/.test(joined)) return 'Brewery';
  if (/night_club/.test(joined)) return 'Nightlife spot';
  if (/seafood|oyster/.test(joined)) return 'Seafood spot';
  if (/cocktail|bar/.test(joined)) return 'Cocktail bar';
  if (/cafe|coffee/.test(joined)) return 'Cafe';
  if (/pizza/.test(joined)) return 'Pizza spot';
  return 'Restaurant';
}

function inferDealTypes(deals = [], types = []) {
  const text = `${deals.join(' ')} ${types.join(' ')}`.toLowerCase();
  const found = new Set();
  if (/beer|draft|pint/.test(text)) found.add('beer');
  if (/cocktail|margarita|martini/.test(text)) found.add('cocktails');
  if (/wine/.test(text)) found.add('wine');
  if (/oyster/.test(text)) found.add('oysters');
  if (/food|taco|appetizer|snack|bite|pizza|burger/.test(text)) found.add('food');
  if (/entertainment|trivia|music|dj/.test(text)) found.add('entertainment');
  if (!found.size) found.add('food');
  return [...found].filter((type) => DEAL_TYPES.includes(type));
}

function inferFeatures(types = [], vibe = '') {
  const text = `${types.join(' ')} ${vibe}`.toLowerCase();
  const found = new Set(['casual']);
  if (/rooftop/.test(text)) found.add('rooftop');
  if (/waterfront|harbor|bay|beach/.test(text)) found.add('waterfront');
  if (/upscale|fine_dining/.test(text)) found.add('upscale');
  if (/date|romantic/.test(text)) found.add('date night');
  if (/group|sports/.test(text)) found.add('group friendly');
  return [...found].filter((feature) => FEATURES.includes(feature));
}

const MAX_WINDOW_MINUTES = 8 * 60;
const MIN_WINDOW_MINUTES = 30;

/**
 * Is this a happy hour, or did we just read the restaurant's opening hours?
 *
 * Three Cheesecake Factories came through as 11:00–22:00 and a casino as
 * 13:00–08:00. Nobody discounts for eleven hours; those are business hours
 * that happened to sit near the words "happy hour". A window that runs past
 * midnight is real (21:00–00:00), so short backwards spans are allowed.
 */
export function isPlausibleWindow(startTime, endTime) {
  const toMinutes = (value) => {
    const [h, m] = String(value).split(':').map(Number);
    return h * 60 + m;
  };
  const start = toMinutes(startTime);
  let end = toMinutes(endTime);
  if (end <= start) end += 24 * 60;
  const span = end - start;
  return span >= MIN_WINDOW_MINUTES && span <= MAX_WINDOW_MINUTES;
}

const OFFER_SIGNAL = /\$|\d\s*(?:off|for)|%|half[- ](?:off|price)|1\/2\s*(?:off|price)|\bfree\b|\bbogo\b|two for|\bdiscount/i;

/**
 * Drop "deals" that are really page titles or marketing copy.
 *
 * The extractor will happily hand back "FIREHOUSE American Eatery & Lounge" or
 * "Best Gaslamp Happy Hour | American Junkie San Diego" — the name of the page
 * it read, not anything you can order. A line earns its place by naming a
 * price or a discount, or by being short enough to read as an item.
 */
export function stripNonOffers(deals, venueName = '') {
  const nameTokens = String(venueName)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);

  return deals.filter((deal) => {
    const text = String(deal || '').trim();
    if (!text || text.length < 3) return false;
    if (/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*[-–]?\s*(?:mon|tue|wed|thu|fri|sat|sun)?[a-z]*\s*:?\s*$/i.test(text)) {
      return false;
    }
    if (OFFER_SIGNAL.test(text)) return true;
    // No price and it echoes the venue's own name: that is a heading.
    const lower = text.toLowerCase();
    const echoes = nameTokens.filter((token) => lower.includes(token)).length;
    if (echoes >= 2 || (echoes >= 1 && text.length > 30)) return false;
    return text.length <= 60;
  });
}

export function normalizeVenue(record, nextId) {
  const lat = record.location?.latitude ?? record.lat;
  const lng = record.location?.longitude ?? record.lng;
  if (!inCounty(lat, lng)) return null;

  const name = record.displayName?.text || record.displayName || record.name || '';
  if (!name.trim()) return null;
  const address = record.formattedAddress || record.address;
  const website = isUsableVenueWebsite(record.websiteUri || record.website)
    ? (record.websiteUri || record.website)
    : '';
  const hh = record.happyHour;
  if (!hh?.startTime || !hh?.endTime || !hh?.days?.length) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hh.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hh.endTime)) return null;

  if (!isPlausibleWindow(hh.startTime, hh.endTime)) return null;

  const deals = finalizeDeals(stripNonOffers(hh.deals || [], name));

  const sourceUrl = hh.sourcePage || record.googleMapsUri || website;
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;

  return {
    id: nextId,
    name,
    neighborhood: guessNeighborhood(lat, lng, address),
    address,
    lat,
    lng,
    days: hh.days.filter((day) => DAY_NAMES.includes(day)),
    startTime: hh.startTime,
    endTime: hh.endTime,
    deals,
    vibe: inferVibe(record.primaryType, record.types),
    website,
    phone: record.nationalPhoneNumber || record.phone || undefined,
    verified: false,
    lastVerifiedAt: null,
    sourceUrl,
    dealTypes: inferDealTypes(deals, record.types || []),
    features: inferFeatures(record.types || [], inferVibe(record.primaryType, record.types)),
    seoHidden: hh.confidence !== 'high',
    // Every catalog venue carries this explicitly; leaving it undefined on
    // imports makes visibility depend on how each consumer reads a missing key.
    listingStatus: 'published',
    _import: {
      googlePlaceId: record.googlePlaceId || record.id?.replace(/^places\//, ''),
      slug: slugify(name),
      rating: record.rating ?? null,
      reviewCount: record.userRatingCount ?? null,
      happyHourSource: hh.source,
      happyHourConfidence: hh.confidence,
      importedAt: new Date().toISOString(),
    },
  };
}

export function stripImportMeta(venue) {
  const { _import, ...rest } = venue;
  return rest;
}
