import { COUNTY_BOUNDS, DAY_NAMES, DEAL_TYPES, FEATURES, NEIGHBORHOOD_BOXES } from './constants.mjs';
import { finalizeDeals } from './deals.mjs';

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function inCounty(lat, lng) {
  return lat >= COUNTY_BOUNDS.minLat && lat <= COUNTY_BOUNDS.maxLat
    && lng >= COUNTY_BOUNDS.minLng && lng <= COUNTY_BOUNDS.maxLng;
}

export function guessNeighborhood(lat, lng, formattedAddress = '') {
  for (const box of NEIGHBORHOOD_BOXES) {
    if (lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng && lng <= box.maxLng) {
      return box.name;
    }
  }
  const parts = formattedAddress.split(',').map((part) => part.trim());
  for (const component of parts) {
    const hit = NEIGHBORHOOD_BOXES.find((box) => component.toLowerCase().includes(box.name.toLowerCase()));
    if (hit) return hit.name;
  }
  for (const part of parts) {
    if (/quarter|district|park|beach|jolla|hillcrest|obrien/i.test(part) && !/county|california|united states|usa/i.test(part)) {
      return part.replace(/\s+(CA|California)\s+\d{5}.*$/i, '').trim() || part;
    }
  }
  if (/la jolla/i.test(formattedAddress)) return 'La Jolla';
  if (/hillcrest/i.test(formattedAddress)) return 'Hillcrest';
  if (/ocean beach|\bOB\b/i.test(formattedAddress)) return 'Ocean Beach';
  if (/del mar/i.test(formattedAddress)) return 'Del Mar';
  if (/carlsbad/i.test(formattedAddress)) return 'Carlsbad';
  if (/encinitas/i.test(formattedAddress)) return 'Encinitas';
  if (/coronado/i.test(formattedAddress)) return 'Coronado';
  return 'San Diego';
}

function inferVibe(primaryType, types = []) {
  const joined = [primaryType, ...types].join(' ').toLowerCase();
  if (/wine_bar|winery/.test(joined)) return 'Wine bar';
  if (/brewery|brewpub/.test(joined)) return 'Brewery';
  if (/night_club/.test(joined)) return 'Nightlife spot';
  if (/seafood|oyster/.test(joined)) return 'Seafood spot';
  if (/cocktail|bar/.test(joined)) return 'Cocktail bar';
  if (/cafe|coffee/.test(joined)) return 'Cafe';
  if (/pizza/.test(joined)) return 'Pizza spot';
  return 'Restaurant';
}

function inferDealTypes(deals = [], types = []) {
  const text = `${deals.join(' ')} ${types.join(' ')}`.toLowerCase();
  const found = new Set();
  if (/beer|draft|pint/.test(text)) found.add('beer');
  if (/cocktail|margarita|martini/.test(text)) found.add('cocktails');
  if (/wine/.test(text)) found.add('wine');
  if (/oyster/.test(text)) found.add('oysters');
  if (/food|taco|appetizer|snack|bite|pizza|burger/.test(text)) found.add('food');
  if (/entertainment|trivia|music|dj/.test(text)) found.add('entertainment');
  if (!found.size) found.add('food');
  return [...found].filter((type) => DEAL_TYPES.includes(type));
}

function inferFeatures(types = [], vibe = '') {
  const text = `${types.join(' ')} ${vibe}`.toLowerCase();
  const found = new Set(['casual']);
  if (/rooftop/.test(text)) found.add('rooftop');
  if (/waterfront|harbor|bay|beach/.test(text)) found.add('waterfront');
  if (/upscale|fine_dining/.test(text)) found.add('upscale');
  if (/date|romantic/.test(text)) found.add('date night');
  if (/group|sports/.test(text)) found.add('group friendly');
  return [...found].filter((feature) => FEATURES.includes(feature));
}

export function normalizeVenue(record, nextId) {
  const lat = record.location?.latitude ?? record.lat;
  const lng = record.location?.longitude ?? record.lng;
  if (!inCounty(lat, lng)) return null;

  const name = record.displayName?.text || record.displayName || record.name || '';
  if (!name.trim()) return null;
  const address = record.formattedAddress || record.address;
  const website = record.websiteUri || record.website || record.googleMapsUri;
  const hh = record.happyHour;
  if (!hh?.startTime || !hh?.endTime || !hh?.days?.length) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hh.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hh.endTime)) return null;

  const deals = finalizeDeals(hh.deals || []);

  const sourceUrl = hh.sourcePage || record.googleMapsUri || website;
  if (!website || !/^https?:\/\//i.test(website)) return null;
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) return null;

  return {
    id: nextId,
    name,
    neighborhood: guessNeighborhood(lat, lng, address),
    address,
    lat,
    lng,
    days: hh.days.filter((day) => DAY_NAMES.includes(day)),
    startTime: hh.startTime,
    endTime: hh.endTime,
    deals,
    vibe: inferVibe(record.primaryType, record.types),
    website,
    phone: record.nationalPhoneNumber || record.phone || undefined,
    verified: false,
    lastVerifiedAt: null,
    sourceUrl,
    dealTypes: inferDealTypes(deals, record.types || []),
    features: inferFeatures(record.types || [], inferVibe(record.primaryType, record.types)),
    seoHidden: hh.confidence !== 'high',
    _import: {
      googlePlaceId: record.googlePlaceId || record.id?.replace(/^places\//, ''),
      slug: slugify(name),
      rating: record.rating ?? null,
      reviewCount: record.userRatingCount ?? null,
      happyHourSource: hh.source,
      happyHourConfidence: hh.confidence,
      importedAt: new Date().toISOString(),
    },
  };
}

export function stripImportMeta(venue) {
  const { _import, ...rest } = venue;
  return rest;
}
