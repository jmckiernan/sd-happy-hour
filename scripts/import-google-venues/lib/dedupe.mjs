function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    // "The Waterfront" and "Waterfront" are the same venue; leaving the article
    // in made exact-name matching miss the clear duplicates we later found.
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length === 10 ? digits : '';
}

/** Street number + street name before city/state, enough to compare locations. */
function normalizeStreetAddress(address) {
  const first = String(address || '').split(',')[0] || '';
  return first
    .toLowerCase()
    .replace(/\b(street|st|avenue|ave|boulevard|blvd|drive|dr|road|rd|lane|ln|court|ct|way|place|pl)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function phoneOf(record) {
  return normalizePhone(record.nationalPhoneNumber || record.phone || '');
}

function addressOf(record) {
  return normalizeStreetAddress(record.formattedAddress || record.address || '');
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

function nearEnough(candidate, venue, meters = 120) {
  const lat = candidate.location?.latitude ?? candidate.lat;
  const lng = candidate.location?.longitude ?? candidate.lng;
  if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(venue.lat) && Number.isFinite(venue.lng)) {
    return distanceMeters(lat, lng, venue.lat, venue.lng) < meters;
  }
  // No coordinates on one side: only treat as near when another strong key
  // already matched (caller decides). Returning true here would collapse
  // same-name venues across the county.
  return false;
}

function namesCompatible(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aTokens = new Set(a.split(' ').filter((t) => t.length > 2));
  const bTokens = b.split(' ').filter((t) => t.length > 2);
  if (!aTokens.size || !bTokens.length) return false;
  const overlap = bTokens.filter((t) => aTokens.has(t)).length;
  return overlap >= Math.min(2, bTokens.length) && overlap / Math.max(aTokens.size, bTokens.length) >= 0.5;
}

/**
 * The catalog venue this candidate already is, or null.
 *
 * Callers need the venue itself, not just a yes/no: once the catalog carries
 * claimable stubs, "already present" is frequently a stub waiting for exactly
 * the happy hour this candidate is bringing, and that is an upgrade rather
 * than a duplicate to discard.
 *
 * Match order:
 * 1. place ID
 * 2. same normalized name within 120 m (leading "The" ignored)
 * 3. same phone + compatible name within 250 m (hotel shared lines need proximity)
 * 4. same street address + compatible name
 */
export function findMatchingVenue(candidate, existingVenues, byPlaceId = new Map()) {
  const placeId = candidate.googlePlaceId || candidate.id?.replace(/^places\//, '');
  if (placeId && byPlaceId.has(placeId)) return byPlaceId.get(placeId);

  const name = normalizeName(nameOf(candidate));
  const phone = phoneOf(candidate);
  const street = addressOf(candidate);

  for (const venue of existingVenues) {
    const venueName = normalizeName(venue.name);
    if (name && venueName === name && nearEnough(candidate, venue, 120)) return venue;
  }

  if (phone) {
    const candLat = candidate.location?.latitude ?? candidate.lat;
    const candLng = candidate.location?.longitude ?? candidate.lng;
    const hasCoords = Number.isFinite(candLat) && Number.isFinite(candLng);
    for (const venue of existingVenues) {
      if (normalizePhone(venue.phone) !== phone) continue;
      if (!namesCompatible(name, normalizeName(venue.name))) continue;
      // Shared hotel / resort lines need proximity when we have coordinates.
      // Without coordinates, only accept an exact name match so "Par Lounge"
      // does not swallow "Oaks Grille" on the same switchboard.
      if (hasCoords) {
        if (nearEnough(candidate, venue, 250)) return venue;
      } else if (name && name === normalizeName(venue.name)) {
        return venue;
      }
    }
  }

  if (street && name) {
    for (const venue of existingVenues) {
      if (normalizeStreetAddress(venue.address) !== street) continue;
      if (!namesCompatible(name, normalizeName(venue.name))) continue;
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

export {
  normalizeName,
  normalizePhone,
  normalizeStreetAddress,
  namesCompatible,
  nameOf,
  phoneOf,
  addressOf,
};
