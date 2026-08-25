export const MARKET_AREAS = [
  { key: 'coastal_north', label: 'Coastal North County' },
  { key: 'north_inland', label: 'North Inland' },
  { key: 'la_jolla_utc', label: 'La Jolla / UTC' },
  { key: 'coastal_central', label: 'Central Coast' },
  { key: 'central_san_diego', label: 'Central San Diego' },
  { key: 'urban_core', label: 'Urban Core' },
  { key: 'east_county', label: 'East County' },
  { key: 'south_bay', label: 'South Bay' },
  { key: 'outside_market', label: 'Outside San Diego market' },
] as const;

export type MarketAreaKey = (typeof MARKET_AREAS)[number]['key'];

const LABELS = new Map(MARKET_AREAS.map((area) => [area.key, area.label]));

export function marketAreaLabel(key: string): string {
  return LABELS.get(key as MarketAreaKey) || 'Other area';
}

/**
 * Convert a precise point to one intentionally broad market area. The point
 * is never returned or persisted. These are reporting markets, not claims
 * about municipal or neighborhood boundaries.
 */
export function marketAreaForCoordinates(latitude: number, longitude: number): MarketAreaKey {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new RangeError('A valid latitude and longitude are required.');
  }
  if (latitude < 32.50 || latitude > 33.55 || longitude < -117.65 || longitude > -116.60) {
    return 'outside_market';
  }
  if (latitude < 32.70) return 'south_bay';
  if (longitude > -117.02) return 'east_county';
  if (latitude >= 33.00) return longitude < -117.18 ? 'coastal_north' : 'north_inland';
  if (latitude >= 32.84 && longitude < -117.20) return 'la_jolla_utc';
  if (latitude >= 32.80 && longitude < -117.16) return 'coastal_central';
  if (latitude >= 32.80) return 'central_san_diego';
  return 'urban_core';
}

