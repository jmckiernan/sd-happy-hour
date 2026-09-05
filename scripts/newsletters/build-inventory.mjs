#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUsableVenueWebsite } from '../import-google-venues/lib/website-ownership.mjs';
import { classifyCounty } from '../import-google-venues/lib/county.mjs';
import { isBlockedChain } from '../import-google-venues/lib/chain-blocklist.mjs';
import { isExcludedCategory } from '../import-google-venues/lib/category-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = path.join(ROOT, '.data', 'newsletters', 'inventory.json');
const ENRICHED = path.join(ROOT, '.data', 'import', 'google', 'enriched.json');
const NON_VENUE_HOST = /^(?:www\.)?(?:gmail\.com|instagram\.com|facebook\.com|m\.facebook\.com|rebrand\.ly)$/i;

function option(name, fallback) {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return value === undefined ? fallback : value;
}

function host(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return '' }
}

function website(value) {
  try {
    const url = new URL(String(value || ''));
    return /^https?:$/.test(url.protocol) ? url.toString() : '';
  } catch { return '' }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback }
}

const allVenues = await readJson(path.join(ROOT, 'public', 'data', 'happy-hours.json'), []);
const venues = allVenues.filter((venue) => venue.listingStatus === 'published')
  .filter((venue) => isUsableVenueWebsite(venue.website))
  .filter((venue) => !NON_VENUE_HOST.test(host(venue.website)));
const previous = await readJson(OUTPUT, { targets: [] });
const previousByHost = new Map(previous.targets?.map((target) => [target.host, target]) || []);
const grouped = new Map();

for (const venue of venues) {
  const url = website(venue.website);
  const hostname = host(url);
  if (!hostname) continue;
  const target = grouped.get(hostname) || {
    host: hostname,
    website: url,
    source: 'listed',
    venueIds: [],
    venueNames: [],
    neighborhoods: [],
  };
  target.venueIds.push(venue.id);
  target.venueNames.push(venue.name);
  if (venue.neighborhood) target.neighborhoods.push(venue.neighborhood);
  grouped.set(hostname, target);
}

const listedPlaceIds = new Set(venues.map((venue) => venue.placeId).filter(Boolean));
const listedNames = new Set(venues.map((venue) => String(venue.name || '').trim().toLowerCase()).filter(Boolean));
const enriched = await readJson(ENRICHED, { places: {} });
const popularLimit = Math.max(0, Number(option('popular-limit', 100)) || 0);
const popularMinRating = Math.max(0, Number(option('popular-min-rating', 4.2)) || 4.2);
const popularMinReviews = Math.max(0, Number(option('popular-min-reviews', 50)) || 50);
const unlisted = Object.values(enriched.places || {})
  .filter((place) => place.qualified && website(place.websiteUri) && isUsableVenueWebsite(place.websiteUri))
  .filter((place) => !NON_VENUE_HOST.test(host(place.websiteUri)))
  .filter((place) => classifyCounty(place).inCounty)
  .filter((place) => !isBlockedChain(String(place.displayName?.text || place.displayName || '')))
  .filter((place) => !isExcludedCategory(place.primaryType, String(place.displayName?.text || place.displayName || '')))
  .filter((place) => Number(place.rating || 0) >= popularMinRating)
  .filter((place) => Number(place.userRatingCount || 0) >= popularMinReviews)
  .filter((place) => !listedPlaceIds.has(place.googlePlaceId || place.id))
  .filter((place) => !listedNames.has(String(place.displayName?.text || place.displayName || '').trim().toLowerCase()))
  .sort((a, b) => Number(b.userRatingCount || 0) - Number(a.userRatingCount || 0))
  .slice(0, popularLimit);

for (const place of unlisted) {
  const url = website(place.websiteUri);
  const hostname = host(url);
  if (!hostname) continue;
  const name = String(place.displayName?.text || place.displayName || '').trim();
  const existing = grouped.get(hostname);
  if (existing) {
    if (name) existing.venueNames.push(name);
    continue;
  }
  grouped.set(hostname, {
    host: hostname,
    website: url,
    source: 'popular_unlisted',
    venueIds: [],
    venueNames: name ? [name] : [],
    neighborhoods: [],
    rating: place.rating ?? null,
    reviewCount: place.userRatingCount ?? 0,
    placeId: place.googlePlaceId || place.id || null,
  });
}

const targets = [...grouped.values()].map((target) => {
  const prior = previousByHost.get(target.host) || {};
  return {
    ...target,
    venueIds: [...new Set(target.venueIds)],
    venueNames: [...new Set(target.venueNames)],
    neighborhoods: [...new Set(target.neighborhoods)],
    status: prior.status || 'pending',
    newsletterUrl: prior.newsletterUrl || null,
    attemptedAt: prior.attemptedAt || null,
    confirmedAt: prior.confirmedAt || null,
    detail: prior.detail || null,
  };
}).sort((a, b) => {
  if (a.source !== b.source) return a.source === 'popular_unlisted' ? -1 : 1;
  return Number(b.reviewCount || 0) - Number(a.reviewCount || 0) || a.host.localeCompare(b.host);
});

await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  counts: {
    listedVenues: venues.length,
    listedWithWebsites: venues.filter((venue) => website(venue.website)).length,
    uniqueDomains: targets.length,
    popularUnlisted: targets.filter((target) => target.source === 'popular_unlisted').length,
  },
  targets,
}, null, 2)}\n`);

console.log(`Newsletter inventory: ${targets.length} domains`);
console.log(`  Published venues with websites: ${venues.filter((venue) => website(venue.website)).length}`);
console.log(`  Popular unlisted candidates: ${targets.filter((target) => target.source === 'popular_unlisted').length}`);
console.log(`  Wrote ${OUTPUT}`);
