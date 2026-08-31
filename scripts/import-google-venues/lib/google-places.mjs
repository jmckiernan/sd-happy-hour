import { sleep } from './io.mjs';

const PLACES_BASE = 'https://places.googleapis.com/v1';

function apiKey() {
  const key = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error('Missing GOOGLE_PLACES_API_KEY (or GOOGLE_MAPS_API_KEY). Enable Places API (New) in Google Cloud.');
  }
  return key;
}

async function placesFetch(pathname, { method = 'GET', body, fieldMask }) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': apiKey(),
  };
  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;

  const response = await fetch(`${PLACES_BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Places ${response.status}: ${text.slice(0, 400)}`);
  }
  return response.json();
}

// `places.rating` and `places.userRatingCount` are Enterprise fields, not Pro,
// so this is the Nearby Search Enterprise SKU at $35/1k. Nearby Search has no
// Essentials tier — Pro at $32/1k is the floor no matter how little we ask for —
// so those two fields cost $3/1k, and having them free in the search response is
// what lets enrich prefilter before buying $20 Place Details. Easily worth it.
//
// Everything else below is Pro or Essentials and therefore free at this tier.
// `places.formattedAddress` in particular is the only thing a claimable stub
// needs that the search response was previously missing, so capturing it here
// removes a $5/1k Essentials Details call per stub. Adding any Atmosphere field
// would re-price the call to $40/1k; discovery is about finding IDs, so don't.
const DISCOVERY_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.googleMapsUri',
  'places.plusCode',
  'places.photos',
].join(',');

// Billing is by the highest tier any requested field belongs to, so one stray
// field re-prices the whole call. `regularSecondaryOpeningHours` (Google's own
// happy-hour block) and `websiteUri` are Enterprise and we genuinely need both,
// so Place Details Enterprise, $20/1k, is the floor here.
//
// The corollary is that every Essentials and Pro field is *free* inside this
// call — the price is already set by the Enterprise fields above them. So this
// mask asks for everything at or below Enterprise that could plausibly end up on
// a venue page, a map, or the admin dashboard. Nothing here changes the bill.
//
// What is deliberately absent is Atmosphere. servesBeer/servesWine/
// servesCocktails used to sit in this list with nothing reading them, and being
// Atmosphere fields they quietly charged every call $25/1k instead of $20.
// Atmosphere is genuinely useful (see FULL_CAPTURE_DETAILS_MASK) but it is a
// +25% decision, not a free one, so it is opt-in rather than the default that
// every future refresh run silently inherits.
const DETAILS_MASK = [
  // Essentials (IDs only) — unlimited, free. Photo *names*, not photo bytes;
  // fetching the media itself is a separate $7/1k SKU.
  'id',
  'photos',
  // Essentials
  'addressComponents',
  'adrFormatAddress',
  'formattedAddress',
  'location',
  'plusCode',
  'postalAddress',
  'shortFormattedAddress',
  'types',
  'viewport',
  // Pro
  'accessibilityOptions',
  'businessStatus',
  'containingPlaces',
  'displayName',
  'googleMapsLinks',
  'googleMapsUri',
  'iconBackgroundColor',
  'iconMaskBaseUri',
  'openingDate',
  'primaryType',
  'primaryTypeDisplayName',
  'pureServiceAreaBusiness',
  'subDestinations',
  'timeZone',
  'utcOffsetMinutes',
  // Enterprise — the tier we are paying for, and the reason we pay it.
  'internationalPhoneNumber',
  'nationalPhoneNumber',
  'priceLevel',
  'priceRange',
  'rating',
  'regularOpeningHours',
  'regularSecondaryOpeningHours',
  'userRatingCount',
  'websiteUri',
].join(',');

/**
 * Everything above, plus the Atmosphere fields worth having.
 *
 * Atmosphere re-prices the whole call from $20/1k to $25/1k, so this is for the
 * one-time full-county capture run, not for routine refreshes. What it buys is
 * the amenity data nothing else can tell us — `outdoorSeating` and `allowsDogs`,
 * which the catalog publishes as named booleans, `servesBeer`/`servesWine`/
 * `servesCocktails` for deal types, `liveMusic` for entertainment.
 *
 * Excluded on purpose, and free to exclude since the tier is already set:
 * `reviews`, `reviewSummary`, `generativeSummary` and `neighborhoodSummary` are
 * bulk Google-authored text we do not republish, and they carry the tightest
 * caching and attribution strings; `evChargeOptions`, `evChargeAmenitySummary`
 * and `fuelOptions` describe gas stations and chargers, not bars.
 */
const FULL_CAPTURE_DETAILS_MASK = [
  DETAILS_MASK,
  'allowsDogs',
  'curbsidePickup',
  'delivery',
  'dineIn',
  'editorialSummary',
  'goodForChildren',
  'goodForGroups',
  'goodForWatchingSports',
  'liveMusic',
  'menuForChildren',
  'outdoorSeating',
  'parkingOptions',
  'paymentOptions',
  'reservable',
  'restroom',
  'servesBeer',
  'servesBreakfast',
  'servesBrunch',
  'servesCocktails',
  'servesCoffee',
  'servesDessert',
  'servesDinner',
  'servesLunch',
  'servesVegetarianFood',
  'servesWine',
  'takeout',
].join(',');

/**
 * Just enough to put a claimable stub page on the site.
 *
 * Name, rating, review count and coordinates already come back free inside the
 * Nearby Search response, so the only thing a stub is missing is its street
 * address — and address fields are Essentials, at $5/1k with the first 10,000
 * each month free. Reserve the Enterprise mask above for venues we actually
 * intend to scrape a happy hour from.
 */
const STUB_DETAILS_MASK = [
  'id',
  'formattedAddress',
  'addressComponents',
  'location',
  'types',
].join(',');

export async function nearbySearch({ lat, lng, radiusMeters, includedType, delayMs = 250 }) {
  const data = await placesFetch('/places:searchNearby', {
    method: 'POST',
    fieldMask: DISCOVERY_MASK,
    body: {
      includedTypes: [includedType],
      maxResultCount: 20,
      rankPreference: 'POPULARITY',
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: radiusMeters,
        },
      },
    },
  });
  await sleep(delayMs);
  return data.places || [];
}

const TEXT_SEARCH_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.businessStatus',
].join(',');

/**
 * Look a place up by name and address.
 *
 * The nearby-search grid only returns what it ranks highly in each circle, so
 * it misses locations a brand publishes itself — 8 of Board & Brew's 14 San
 * Diego stores were never discovered. When we already have a street address,
 * asking for it directly is both cheaper and complete.
 */
export async function textSearch(textQuery, { delayMs = 250, maxResults = 3 } = {}) {
  const data = await placesFetch('/places:searchText', {
    method: 'POST',
    fieldMask: TEXT_SEARCH_MASK,
    body: { textQuery, maxResultCount: maxResults },
  });
  await sleep(delayMs);
  return data.places || [];
}

/**
 * Buy Place Details.
 *
 * Set `IMPORT_CAPTURE_ALL=1` (or pass `captureAll`) to use the Atmosphere mask.
 * That costs $25/1k instead of $20/1k, so it belongs on a deliberate one-time
 * full-county run and nowhere else.
 */
export async function placeDetails(placeId, delayMs = 250, { captureAll } = {}) {
  const id = placeId.replace(/^places\//, '');
  const full = captureAll ?? process.env.IMPORT_CAPTURE_ALL === '1';
  const data = await placesFetch(`/places/${id}`, {
    fieldMask: full ? FULL_CAPTURE_DETAILS_MASK : DETAILS_MASK,
  });
  await sleep(delayMs);
  return data;
}

/** Address-only lookup for venues we only need a claimable page for. */
export async function placeDetailsEssentials(placeId, delayMs = 250) {
  const id = placeId.replace(/^places\//, '');
  const data = await placesFetch(`/places/${id}`, {
    fieldMask: STUB_DETAILS_MASK,
  });
  await sleep(delayMs);
  return data;
}

export function placeIdKey(place) {
  const raw = place.id || place.name || '';
  return raw.replace(/^places\//, '');
}

/**
 * The candidate row both discovery scripts store.
 *
 * Keeps every field the discovery mask now returns, because they arrived free
 * and a second run to collect them would not be.
 */
export function candidateRecord(place, includedType, existing) {
  return {
    id: placeIdKey(place),
    displayName: displayName(place),
    location: place.location,
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? 0,
    businessStatus: place.businessStatus || 'OPERATIONAL',
    primaryType: place.primaryType || includedType,
    primaryTypeDisplayName: place.primaryTypeDisplayName?.text || null,
    types: place.types || [],
    formattedAddress: place.formattedAddress || null,
    shortFormattedAddress: place.shortFormattedAddress || null,
    googleMapsUri: place.googleMapsUri || null,
    plusCode: place.plusCode || null,
    photoNames: (place.photos || []).map((photo) => photo.name).filter(Boolean),
    discoveredAt: existing?.discoveredAt || new Date().toISOString(),
  };
}

export function displayName(place) {
  return place.displayName?.text || place.displayName || '';
}

export async function placePhotoUri(placeId, maxHeightPx = 1200, delayMs = 200) {
  const photo = await downloadPlacePhoto(placeId, maxHeightPx, delayMs);
  return photo?.uri || null;
}

export async function downloadPlacePhoto(placeId, maxHeightPx = 1200, delayMs = 200) {
  const id = placeId.replace(/^places\//, '');
  const details = await placesFetch(`/places/${id}`, {
    fieldMask: 'photos',
  });
  await sleep(delayMs);
  const photoName = details.photos?.[0]?.name;
  if (!photoName) return null;

  const response = await fetch(
    `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=${maxHeightPx}&skipHttpRedirect=true`,
    {
      headers: { 'X-Goog-Api-Key': apiKey() },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) return null;
  const data = await response.json();
  const uri = data.photoUri;
  if (!uri) return null;

  const imageResponse = await fetch(uri, { signal: AbortSignal.timeout(60_000) });
  if (!imageResponse.ok) return null;
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
  return { uri, bytes, contentType };
}
