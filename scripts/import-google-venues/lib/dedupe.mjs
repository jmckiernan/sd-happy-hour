function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function distanceMeters(aLat, aLng, bLat, bLng) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earth = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(h));
}

export function isDuplicateCandidate(candidate, existingVenues, googleIds = new Set()) {
  const placeId = candidate.googlePlaceId || candidate.id?.replace(/^places\//, '');
  if (placeId && googleIds.has(placeId)) return true;

  const name = normalizeName(candidate.displayName?.text || candidate.name);
  const lat = candidate.location?.latitude ?? candidate.lat;
  const lng = candidate.location?.longitude ?? candidate.lng;

  for (const venue of existingVenues) {
    if (normalizeName(venue.name) === name) {
      if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(venue.lat) && Number.isFinite(venue.lng)) {
        if (distanceMeters(lat, lng, venue.lat, venue.lng) < 120) return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

export function buildExistingIndex(existingVenues) {
  const googleIds = new Set(
    existingVenues.map((venue) => venue._import?.googlePlaceId).filter(Boolean)
  );
  return { existingVenues, googleIds };
}

export function dedupeRecords(records, existingVenues) {
  const { googleIds } = buildExistingIndex(existingVenues);
  const seen = new Set();
  const kept = [];
  const skipped = [];

  for (const record of records) {
    const placeId = record.googlePlaceId || record.id?.replace(/^places\//, '');
    if (placeId && seen.has(placeId)) {
      skipped.push({ record, reason: 'duplicate-place-id' });
      continue;
    }
    if (isDuplicateCandidate(record, existingVenues, googleIds)) {
      skipped.push({ record, reason: 'matches-existing-venue' });
      continue;
    }
    if (placeId) seen.add(placeId);
    kept.push(record);
  }
  return { kept, skipped };
}
