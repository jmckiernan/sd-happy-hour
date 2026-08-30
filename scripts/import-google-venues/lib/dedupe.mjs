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

/**
 * The catalog venue this candidate already is, or null.
 *
 * Callers need the venue itself, not just a yes/no: once the catalog carries
 * claimable stubs, "already present" is frequently a stub waiting for exactly
 * the happy hour this candidate is bringing, and that is an upgrade rather
 * than a duplicate to discard.
 */
export function findMatchingVenue(candidate, existingVenues, byPlaceId = new Map()) {
  const placeId = candidate.googlePlaceId || candidate.id?.replace(/^places\//, '');
  if (placeId && byPlaceId.has(placeId)) return byPlaceId.get(placeId);

  const name = normalizeName(nameOf(candidate));
  if (!name) return null;
  const lat = candidate.location?.latitude ?? candidate.lat;
  const lng = candidate.location?.longitude ?? candidate.lng;

  for (const venue of existingVenues) {
    if (normalizeName(venue.name) !== name) continue;
    if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(venue.lat) && Number.isFinite(venue.lng)) {
      if (distanceMeters(lat, lng, venue.lat, venue.lng) < 120) return venue;
    } else {
      return venue;
    }
  }
  return null;
}

export function isDuplicateCandidate(candidate, existingVenues, googleIds = new Set()) {
  const byPlaceId = new Map();
  for (const venue of existingVenues) {
    for (const id of [venue._import?.googlePlaceId, venue.placeId]) {
      if (id && googleIds.has(id)) byPlaceId.set(id, venue);
    }
  }
  return findMatchingVenue(candidate, existingVenues, byPlaceId) !== null;
}

export function buildExistingIndex(existingVenues) {
  // Catalog venues carry the id at the top level as `placeId`; `_import` is
  // empty on every one of them, so relying on it alone matched nothing.
  const byPlaceId = new Map();
  for (const venue of existingVenues) {
    for (const id of [venue._import?.googlePlaceId, venue.placeId]) {
      if (id) byPlaceId.set(id, venue);
    }
  }
  return { existingVenues, byPlaceId, googleIds: new Set(byPlaceId.keys()) };
}

/**
 * Split candidates into new venues, upgrades to existing stubs, and true
 * duplicates.
 *
 * `upgrades` exists because the catalog now carries a claimable page for every
 * qualifying venue. Without it, finding a happy hour for a venue we already
 * stubbed would read as "already have it" and be thrown away — which silently
 * dropped all 112 findings the first time this ran.
 */
export function dedupeRecords(records, existingVenues) {
  const { byPlaceId } = buildExistingIndex(existingVenues);
  const seen = new Set();
  const kept = [];
  const upgrades = [];
  const skipped = [];

  for (const record of records) {
    const placeId = record.googlePlaceId || record.id?.replace(/^places\//, '');
    if (placeId && seen.has(placeId)) {
      skipped.push({ record, reason: 'duplicate-place-id' });
      continue;
    }
    const match = findMatchingVenue(record, existingVenues, byPlaceId);
    if (match) {
      if (match.hasHappyHourData === false && !match.startTime) {
        if (placeId) seen.add(placeId);
        upgrades.push({ record, venue: match });
      } else {
        skipped.push({ record, reason: 'matches-existing-venue', venue: match });
      }
      continue;
    }
    if (placeId) seen.add(placeId);
    kept.push(record);
  }
  return { kept, upgrades, skipped };
}
