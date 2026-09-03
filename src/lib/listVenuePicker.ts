/**
 * Candidates shown when adding a venue to a shared list.
 *
 * happy-hours.json still carries some import stubs that share a name and
 * neighborhood with a real listing (e.g. two "Rustic Root · Gaslamp" rows).
 * The picker labels by name + neighborhood, so without collapsing those the
 * dropdown looks broken.
 */

export interface ListPickerVenue {
  id: number;
  name: string;
  neighborhood: string;
  days?: string[];
  startTime?: string;
  endTime?: string;
  deals?: string[];
  seoHidden?: boolean;
  listingStatus?: 'published' | 'unlisted';
  ownerVerified?: boolean;
}

export function isListPickerCandidate(venue: ListPickerVenue): boolean {
  if (venue.seoHidden) return false;
  if (venue.listingStatus === 'unlisted') return false;
  return Boolean(venue.startTime && venue.endTime && venue.days?.length);
}

function labelKey(venue: ListPickerVenue): string {
  return `${venue.name}`.trim().toLowerCase() + '\0' + `${venue.neighborhood}`.trim().toLowerCase();
}

function candidateScore(venue: ListPickerVenue): number {
  return (venue.ownerVerified ? 1000 : 0)
    + ((venue.deals?.length || 0) * 10)
    + (venue.startTime ? 1 : 0);
}

/** Prefer the richer listing when two rows would render the same picker label. */
export function preferListPickerVenue(a: ListPickerVenue, b: ListPickerVenue): ListPickerVenue {
  const scoreA = candidateScore(a);
  const scoreB = candidateScore(b);
  if (scoreA !== scoreB) return scoreA > scoreB ? a : b;
  return a.id <= b.id ? a : b;
}

export function venuesForListPicker(venues: readonly ListPickerVenue[]): ListPickerVenue[] {
  const winners = new Map<string, ListPickerVenue>();
  for (const venue of venues) {
    if (!isListPickerCandidate(venue)) continue;
    const key = labelKey(venue);
    const existing = winners.get(key);
    winners.set(key, existing ? preferListPickerVenue(venue, existing) : venue);
  }
  return [...winners.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.neighborhood.localeCompare(right.neighborhood),
  );
}
