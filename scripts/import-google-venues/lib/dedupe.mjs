function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Google returns displayName as `{ text }`, but the enrich cache flattens it to
 * a plain string. Reading only `.text` made every comparison undefined, so
 * dedupe matched nothing and staging offered to re-add the whole catalog.
 */
function nameOf(record) {
  const display = record?.displayName;
  if (typeof display === 'string') return display;
  return display?.text || record?.name || '';
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

  const name = normalizeName(nameOf(candidate));
  if (!name) return false;
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
  // Catalog venues carry the id at the top level as `placeId`; `_import` is
  // empty on every one of them, so relying on it alone matched nothing.
  const googleIds = new Set(
    existingVenues
      .flatMap((venue) => [venue._import?.googlePlaceId, venue.placeId])
      .filter(Boolean)
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
