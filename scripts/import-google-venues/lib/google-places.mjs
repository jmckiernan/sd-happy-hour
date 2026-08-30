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

const DISCOVERY_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.primaryType',
].join(',');

// Billing is by the highest tier any requested field belongs to, so one stray
// field re-prices the whole call. `regularSecondaryOpeningHours` (Google's own
// happy-hour block) and `websiteUri` are Enterprise and we genuinely need both,
// so $20/1k is the floor here. servesBeer/servesWine/servesCocktails used to sit
// in this list and nothing ever read them — they are Atmosphere fields, and they
// were quietly charging every call $25/1k instead.
const DETAILS_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'addressComponents',
  'location',
  'rating',
  'userRatingCount',
  'websiteUri',
  'googleMapsUri',
  'nationalPhoneNumber',
  'primaryType',
  'types',
  'businessStatus',
  'regularSecondaryOpeningHours',
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

export async function placeDetails(placeId, delayMs = 250) {
  const id = placeId.replace(/^places\//, '');
  const data = await placesFetch(`/places/${id}`, {
    fieldMask: DETAILS_MASK,
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
