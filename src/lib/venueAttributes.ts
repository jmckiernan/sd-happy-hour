import type { Venue } from './venues';

/**
 * What Google told us about a venue, turned into things a page can show.
 *
 * The one rule everything here obeys: **absent means unknown, and unknown says
 * nothing.** Google answered `allowsDogs` for 39% of the catalog, so rendering
 * "No dogs" wherever the key is missing would tell 1,694 venues' visitors that
 * dogs are banned when Google simply stayed silent. A venue with three known
 * attributes shows three; it does not show a list of greyed-out maybes.
 *
 * The corollary is that these are affirmative badges. We surface a fact when it
 * is true and stay quiet when it is false or unknown, because "Dog friendly"
 * absent from a page is honest either way, whereas "Not dog friendly" is a
 * claim we would be making on Google's behalf. The underlying data keeps all
 * three states (see `Venue`), so a later surface that genuinely needs to
 * distinguish false from unknown still can.
 */

export interface VenueAttribute {
  key: string;
  label: string;
}

export interface VenueAttributeGroup {
  title: string;
  attributes: VenueAttribute[];
}

/** Plain booleans, in the order they help someone choosing a bar for tonight. */
const BOOLEAN_LABELS: { key: keyof Venue; label: string }[] = [
  { key: 'outdoorSeating', label: 'Outdoor seating' },
  { key: 'liveMusic', label: 'Live music' },
  { key: 'goodForWatchingSports', label: 'Good for watching sports' },
  { key: 'goodForGroups', label: 'Good for groups' },
  { key: 'reservable', label: 'Takes reservations' },
  { key: 'allowsDogs', label: 'Dog friendly' },
  { key: 'servesVegetarianFood', label: 'Vegetarian options' },
  { key: 'restroom', label: 'Restroom' },
];

const PARKING_LABELS: Record<string, string> = {
  freeParkingLot: 'Free lot',
  paidParkingLot: 'Paid lot',
  freeStreetParking: 'Free street parking',
  paidStreetParking: 'Paid street parking',
  freeGarageParking: 'Free garage',
  paidGarageParking: 'Paid garage',
  valetParking: 'Valet',
};

const PAYMENT_LABELS: Record<string, string> = {
  acceptsCreditCards: 'Credit cards',
  acceptsDebitCards: 'Debit cards',
  acceptsNfc: 'Contactless',
  acceptsCashOnly: 'Cash only',
};

const ACCESSIBILITY_LABELS: Record<string, string> = {
  wheelchairAccessibleEntrance: 'Accessible entrance',
  wheelchairAccessibleSeating: 'Accessible seating',
  wheelchairAccessibleRestroom: 'Accessible restroom',
  wheelchairAccessibleParking: 'Accessible parking',
};

const PRICE_LEVEL_LABELS: Record<string, string> = {
  PRICE_LEVEL_FREE: 'Free',
  PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$',
  PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};

/**
 * Pull the true entries out of one of Google's grouped boolean objects.
 *
 * `false` and absent are both dropped, for the same reason: neither is
 * something we are willing to assert on a page.
 */
function affirmative(
  group: Record<string, boolean> | undefined,
  labels: Record<string, string>
): VenueAttribute[] {
  if (!group) return [];
  return Object.keys(labels)
    .filter((key) => group[key] === true)
    .map((key) => ({ key, label: labels[key] }));
}

/** A venue's price as a short string, or null when Google did not say. */
export function formatPriceLevel(venue: Venue): string | null {
  const level = venue.priceLevel ? PRICE_LEVEL_LABELS[venue.priceLevel] : null;
  const range = venue.priceRange;
  if (range && Number.isFinite(range.startPrice) && Number.isFinite(range.endPrice)) {
    const money = `$${range.startPrice}–$${range.endPrice}`;
    return level ? `${level} · ${money} per person` : `${money} per person`;
  }
  return level;
}

/**
 * Every attribute worth showing, grouped, with empty groups already removed.
 *
 * Callers can render this without checking anything: an empty array means the
 * section should not appear at all, which is what keeps a venue Google knows
 * nothing about from rendering a heading over blank space.
 */
export function venueAttributeGroups(venue: Venue): VenueAttributeGroup[] {
  const groups: VenueAttributeGroup[] = [
    {
      title: 'At this venue',
      attributes: BOOLEAN_LABELS.filter(({ key }) => venue[key] === true).map(({ key, label }) => ({
        key: String(key),
        label,
      })),
    },
    { title: 'Parking', attributes: affirmative(venue.parkingOptions, PARKING_LABELS) },
    { title: 'Accessibility', attributes: affirmative(venue.accessibilityOptions, ACCESSIBILITY_LABELS) },
    { title: 'Payment', attributes: affirmative(venue.paymentOptions, PAYMENT_LABELS) },
  ];
  return groups.filter((group) => group.attributes.length > 0);
}

/** Does this venue have anything at all to show? Drives the whole section. */
export function hasVenueAttributes(venue: Venue): boolean {
  return venueAttributeGroups(venue).length > 0 || formatPriceLevel(venue) !== null;
}
