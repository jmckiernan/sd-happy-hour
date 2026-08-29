import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Validates public/data/happy-hours.json — the one piece of accounts/
// submissions-era data that's still tracked in git (users/submissions now
// live in Vercel KV or the local .data/ fallback; see src/lib/kv.ts).
// Run with: npm run validate:data

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const happyHoursPath = path.join(rootDir, 'public', 'data', 'happy-hours.json');
const validDays = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function isTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function hasString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(hasString);
}

function validateListing(listing, label) {
  const errors = [];
  if (!Number.isInteger(listing.id)) errors.push(`${label}: id must be an integer.`);
  if (!hasString(listing.name)) errors.push(`${label}: name is required.`);
  if (!hasString(listing.neighborhood)) errors.push(`${label}: neighborhood is required.`);
  if (!hasString(listing.address)) errors.push(`${label}: address is required.`);
  if (!Number.isFinite(listing.lat)) errors.push(`${label}: lat is required.`);
  if (!Number.isFinite(listing.lng)) errors.push(`${label}: lng is required.`);
  if (Number.isFinite(listing.lat) && (listing.lat < -90 || listing.lat > 90)) errors.push(`${label}: lat is out of range.`);
  if (Number.isFinite(listing.lng) && (listing.lng < -180 || listing.lng > 180)) errors.push(`${label}: lng is out of range.`);
  if (!hasStringArray(listing.days) || listing.days.some((day) => !validDays.has(day))) errors.push(`${label}: days must contain valid day names.`);
  if (Boolean(listing.openTime) !== Boolean(listing.closeTime)) errors.push(`${label}: openTime and closeTime must be supplied together.`);
  if (listing.openTime && !isTime(listing.openTime)) errors.push(`${label}: openTime must be HH:MM when present.`);
  if (listing.closeTime && !isTime(listing.closeTime)) errors.push(`${label}: closeTime must be HH:MM when present.`);
  if (!isTime(listing.startTime)) errors.push(`${label}: startTime must be HH:MM.`);
  if (!isTime(listing.endTime)) errors.push(`${label}: endTime must be HH:MM.`);
  // Deals may legitimately be empty: plenty of venues publish a happy hour
  // without publishing the offers anywhere. Those must say so via dealsUnknown
  // rather than carry a placeholder deal line.
  if (listing.dealsUnknown === true) {
    if (!Array.isArray(listing.deals) || listing.deals.some((deal) => !hasString(deal))) {
      errors.push(`${label}: deals must be a string array when dealsUnknown is set.`);
    }
  } else if (!hasStringArray(listing.deals)) {
    errors.push(`${label}: deals must be a non-empty string array unless dealsUnknown is true.`);
  }
  if ('dealsUnknown' in listing && typeof listing.dealsUnknown !== 'boolean') {
    errors.push(`${label}: dealsUnknown must be boolean when present.`);
  }
  if ('listingStatus' in listing && !['published', 'unlisted'].includes(listing.listingStatus)) {
    errors.push(`${label}: listingStatus must be "published" or "unlisted" when present.`);
  }
  if ('hasHappyHourData' in listing && typeof listing.hasHappyHourData !== 'boolean') {
    errors.push(`${label}: hasHappyHourData must be boolean when present.`);
  }
  if ('publishedByClaim' in listing) {
    if (typeof listing.publishedByClaim !== 'boolean') {
      errors.push(`${label}: publishedByClaim must be boolean when present.`);
    } else if (listing.publishedByClaim && listing.listingStatus === 'unlisted') {
      errors.push(`${label}: publishedByClaim cannot be set on an unlisted venue.`);
    }
  }
  if ('windows' in listing) {
    const windowsValid = Array.isArray(listing.windows) && listing.windows.every(
      (w) => (w?.allDay === true || (isTime(w?.startTime) && isTime(w?.endTime)))
        && hasStringArray(w?.days) && w.days.every((day) => validDays.has(day)),
    );
    if (!windowsValid) errors.push(`${label}: windows must be {days, startTime, endTime} entries.`);
  }
  if ('galleryImages' in listing) {
    const galleryValid = Array.isArray(listing.galleryImages) && listing.galleryImages.every(
      (row) => hasString(row?.url) && /^(\/[^/]|https?:\/\/)/i.test(row.url)
    );
    if (!galleryValid) errors.push(`${label}: galleryImages must be {url} entries when present.`);
  }
  if ('weeklySpecials' in listing) {
    const kinds = new Set(['named_night', 'exchange', 'fixed_price', 'food', 'venue_note', 'event']);
    const specialsValid = Array.isArray(listing.weeklySpecials) && listing.weeklySpecials.every((row) => {
      const hasDays = Array.isArray(row?.days) && row.days.every((day) => validDays.has(day));
      const occasionOk = !row.days?.length ? Boolean(row.occasion) : true;
      return hasString(row?.id) && hasString(row?.label) && hasString(row?.summary)
        && kinds.has(row?.kind) && hasDays && occasionOk
        && Array.isArray(row?.details) && row.details.every(hasString);
    });
    if (!specialsValid) {
      errors.push(`${label}: weeklySpecials must include id, label, kind, summary, details, and days (or an occasion).`);
    }
  }
  if ('lastScrape' in listing) {
    const scrape = listing.lastScrape;
    if (!scrape || typeof scrape !== 'object') {
      errors.push(`${label}: lastScrape must be an object when present.`);
    } else {
      if (typeof scrape.found !== 'boolean') errors.push(`${label}: lastScrape.found must be boolean.`);
      if (!hasString(scrape.outcome)) errors.push(`${label}: lastScrape.outcome is required.`);
      if (!hasString(scrape.observedAt)) errors.push(`${label}: lastScrape.observedAt is required.`);
    }
  }
  if (!hasString(listing.vibe)) errors.push(`${label}: vibe is required.`);
  if (!isUrl(listing.website)) errors.push(`${label}: website must be an http(s) URL.`);
  if (typeof listing.verified !== 'boolean') errors.push(`${label}: verified must be boolean.`);
  if ('seoHidden' in listing && typeof listing.seoHidden !== 'boolean') errors.push(`${label}: seoHidden must be boolean when present.`);
  if (!('lastVerifiedAt' in listing)) errors.push(`${label}: lastVerifiedAt is required, even when null.`);
  if (!isUrl(listing.sourceUrl)) errors.push(`${label}: sourceUrl must be an http(s) URL.`);
  if (!hasStringArray(listing.dealTypes)) errors.push(`${label}: dealTypes must be a non-empty string array.`);
  if (!hasStringArray(listing.features)) errors.push(`${label}: features must be a non-empty string array.`);
  // Optional admin-set featured photo. Absent means the site falls back to the
  // vibe stock photo, so only its shape is checked — same rule as
  // validateListing() in src/lib/validation.ts, since this value is rendered
  // straight into an <img src> on public pages.
  if ('image' in listing && !(hasString(listing.image) && /^(\/[^/]|https?:\/\/)/i.test(listing.image))) {
    errors.push(`${label}: image must be a stored image path or an http(s) URL when present.`);
  }
  return errors;
}

const errors = [];
const happyHours = readJson(happyHoursPath);
const ids = new Set();

if (!Array.isArray(happyHours)) {
  errors.push('happy-hours.json must contain an array.');
} else {
  happyHours.forEach((listing, index) => {
    errors.push(...validateListing(listing, `happy-hours[${index}]`));
    if (ids.has(listing.id)) errors.push(`happy-hours[${index}]: duplicate id ${listing.id}.`);
    ids.add(listing.id);
  });
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Data ok: ${happyHours.length} listings.`);
