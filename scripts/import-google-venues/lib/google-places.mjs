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
  'servesBeer',
  'servesWine',
  'servesCocktails',
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

export async function placeDetails(placeId, delayMs = 250) {
  const id = placeId.replace(/^places\//, '');
  const data = await placesFetch(`/places/${id}`, {
    fieldMask: DETAILS_MASK,
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
