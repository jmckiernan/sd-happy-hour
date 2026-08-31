#!/usr/bin/env node
// Report how often Google actually answered each field we bought.
//
// The Atmosphere run prices per call, not per field, so the mask asks for
// everything. That makes fill rate the only thing that tells us which fields
// are worth modelling: a boolean Google returns for 4% of venues cannot drive a
// filter, because the other 96% would silently vanish from the results.
//
// Usage:
//   node scripts/import-google-venues/audit-atmosphere-fill.mjs

import { readJson } from './lib/io.mjs';
import { ATMOSPHERE_PATH } from './backfill-atmosphere.mjs';

// Below this, a field describes too few venues to build a surface on. It is not
// a correctness threshold — the data is fine — it is the point where a filter
// hides more venues than it finds.
const NOT_WORTH_MODELLING = 0.25;

/** Every field the full-capture mask asks for, so zero-fill fields still show. */
const REQUESTED_FIELDS = [
  'id', 'photos', 'addressComponents', 'adrFormatAddress', 'formattedAddress',
  'location', 'plusCode', 'postalAddress', 'shortFormattedAddress', 'types',
  'viewport', 'accessibilityOptions', 'businessStatus', 'containingPlaces',
  'displayName', 'googleMapsLinks', 'googleMapsUri', 'iconBackgroundColor',
  'iconMaskBaseUri', 'openingDate', 'primaryType', 'primaryTypeDisplayName',
  'pureServiceAreaBusiness', 'subDestinations', 'timeZone', 'utcOffsetMinutes',
  'internationalPhoneNumber', 'nationalPhoneNumber', 'priceLevel', 'priceRange',
  'rating', 'regularOpeningHours', 'regularSecondaryOpeningHours',
  'userRatingCount', 'websiteUri', 'allowsDogs', 'curbsidePickup', 'delivery',
  'dineIn', 'editorialSummary', 'goodForChildren', 'goodForGroups',
  'goodForWatchingSports', 'liveMusic', 'menuForChildren', 'outdoorSeating',
  'parkingOptions', 'paymentOptions', 'reservable', 'restroom', 'servesBeer',
  'servesBreakfast', 'servesBrunch', 'servesCocktails', 'servesCoffee',
  'servesDessert', 'servesDinner', 'servesLunch', 'servesVegetarianFood',
  'servesWine', 'takeout',
];

function isAnswered(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  // `paymentOptions` and friends come back as objects of booleans; an empty one
  // is Google saying nothing rather than saying no.
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function main() {
  const store = readJson(ATMOSPHERE_PATH, { places: {} });
  const places = Object.values(store.places);
  if (!places.length) {
    console.error('No captured places found. Run the backfill first.');
    process.exit(1);
  }

  // Seed every field the mask asked for at zero. A field Google never answered
  // for a single venue appears nowhere in the responses, so counting only what
  // came back would quietly omit exactly the fields most worth knowing about.
  const counts = new Map(REQUESTED_FIELDS.map((field) => [field, 0]));
  for (const place of places) {
    for (const [field, value] of Object.entries(place)) {
      if (field === 'atmosphereFetchedAt') continue;
      if (!counts.has(field)) counts.set(field, 0);
      if (isAnswered(value)) counts.set(field, counts.get(field) + 1);
    }
  }

  const rows = [...counts.entries()]
    .map(([field, answered]) => ({
      field,
      answered,
      rate: answered / places.length,
    }))
    .sort((a, b) => b.rate - a.rate);

  console.log(`Fill rates across ${places.length} captured venues\n`);
  console.log('  rate    answered  field');
  for (const row of rows) {
    const flag = row.rate < NOT_WORTH_MODELLING ? '  <- too sparse to model' : '';
    console.log(
      `  ${(row.rate * 100).toFixed(1).padStart(5)}%  ${String(row.answered).padStart(8)}  ${row.field}${flag}`
    );
  }

  const sparse = rows.filter((row) => row.rate < NOT_WORTH_MODELLING);
  console.log(`\n${sparse.length} field(s) under ${NOT_WORTH_MODELLING * 100}%: ${sparse.map((r) => r.field).join(', ') || 'none'}`);
}

main();
