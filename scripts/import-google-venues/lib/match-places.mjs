import { displayName } from './google-places.mjs';

export function normalizePlaceName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function placeCoords(place) {
  return {
    lat: place.location?.latitude ?? place.lat,
    lng: place.location?.longitude ?? place.lng,
  };
}

export function distanceDegrees(aLat, aLng, bLat, bLng) {
  return Math.hypot(aLat - bLat, aLng - bLng);
}

export function buildPlaceLookup(places) {
  const byName = new Map();
  for (const place of places) {
    const name = normalizePlaceName(displayName(place));
    if (!name) continue;
    const list = byName.get(name) || [];
    list.push(place);
    byName.set(name, list);
  }
  return byName;
}

export function findPlaceForVenue(venue, lookup, maxDistance = 0.01) {
  const name = normalizePlaceName(venue.name);
  const candidates = lookup.get(name) || [];
  if (!candidates.length) return null;

  let best = null;
  let bestDistance = Infinity;
  for (const place of candidates) {
    const { lat, lng } = placeCoords(place);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const distance = distanceDegrees(venue.lat, venue.lng, lat, lng);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = place;
    }
  }
  if (!best || bestDistance > maxDistance) return null;
  return best;
}

export function placeIdFor(place) {
  return place.googlePlaceId || String(place.id || '').replace(/^places\//, '') || null;
}
