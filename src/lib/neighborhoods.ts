import { getVenues, slugify, type Venue } from './venues';

export interface NeighborhoodProfile {
  name: string;
  slug: string;
  shortDescription: string;
  overview: string[];
  planningTip: string;
  nearby: string[];
}

const PROFILES: NeighborhoodProfile[] = [
  {
    name: 'Little Italy',
    slug: 'little-italy',
    shortDescription: 'Compare current happy hour times and deals at bars and restaurants in Little Italy, San Diego.',
    overview: [
      'Little Italy is one of San Diego’s easiest neighborhoods for planning a happy hour on foot. India Street and Kettner Boulevard put seafood bars, cocktail rooms, patios, and chef-driven restaurants within a compact downtown grid.',
      'Weekday deals here tend to start in the mid-afternoon and fill quickly as the dinner crowd arrives. Compare each listing’s current days, times, and menu highlights before choosing a starting point.',
    ],
    planningTip: 'For Thursday or Friday, arrive before 5 PM and use the Waterfront Park or Little Italy trolley stops to avoid circling for street parking.',
    nearby: ['Gaslamp', 'Middletown', 'Harbor Island'],
  },
  {
    name: 'North Park',
    slug: 'north-park',
    shortDescription: 'Find North Park happy hours for craft cocktails, beer, appetizers, and casual group nights in San Diego.',
    overview: [
      'North Park’s happy hour scene clusters around University Avenue and 30th Street, with a mix of cocktail bars, breweries, gastropubs, and game rooms. It works especially well when a group wants options without committing to a formal dinner.',
      'Many venues are walkable from the neighborhood’s central blocks, but their deal windows and available days vary. Use the listings below to compare the current schedule before building a crawl.',
    ],
    planningTip: 'Park once near University Avenue and 30th Street or use a rideshare; the central venues are close enough to visit on foot.',
    nearby: ['South Park', 'Little Italy'],
  },
  {
    name: 'South Park',
    slug: 'south-park',
    shortDescription: 'Explore South Park, San Diego happy hours at neighborhood wine bars, cocktail spots, and patios.',
    overview: [
      'South Park has a smaller, more residential happy hour scene than downtown, which is part of its appeal. Independent wine bars, distinctive cocktail rooms, and patios sit along walkable stretches near 30th Street.',
      'It is a good fit for a low-key date or a neighborhood meet-up. Check the day-by-day schedule below because several South Park deals end before the later dinner rush.',
    ],
    planningTip: 'Street parking is easiest earlier in the afternoon; once you arrive, the main 30th Street corridor is best explored on foot.',
    nearby: ['North Park', 'Gaslamp'],
  },
  {
    name: 'Pacific Beach',
    slug: 'pacific-beach',
    shortDescription: 'Find Pacific Beach happy hours with drink specials, discounted appetizers, patios, and beach-area bars.',
    overview: [
      'Pacific Beach pairs casual bars and restaurants with an easy pre- or post-beach stop. Grand Avenue, Garnet Avenue, and the streets near the boardwalk cover everything from house beer specials to patio appetizers.',
      'The neighborhood gets busiest near sunset and on weekends, while many traditional happy hours remain weekday-only. Confirm the listed days and end time before heading toward the coast.',
    ],
    planningTip: 'Expect slower traffic and limited parking near the water around sunset; arrive early or use a rideshare if timing matters.',
    nearby: ['UTC'],
  },
  {
    name: 'Gaslamp',
    slug: 'gaslamp',
    shortDescription: 'Compare Gaslamp Quarter happy hours at downtown San Diego rooftops, restaurants, and bars.',
    overview: [
      'The Gaslamp Quarter is downtown San Diego’s high-energy option for rooftop drinks, group outings, and a happy hour that can roll into dinner or a night out. Fifth Avenue has the densest concentration of choices.',
      'Downtown event schedules can change how crowded the neighborhood feels, so compare current venue times and check the Padres or convention calendar when you are making a plan.',
    ],
    planningTip: 'Use the trolley when Petco Park or the Convention Center has a major event; downtown parking prices can rise quickly.',
    nearby: ['Little Italy', 'South Park', 'Harbor Island'],
  },
  {
    name: 'UTC',
    slug: 'utc',
    shortDescription: 'Discover current UTC and University City happy hours near Westfield UTC, with San Diego drink specials, food deals, days, and times.',
    overview: [
      'UTC and University City offer polished restaurants and cocktail bars around La Jolla Village Drive and Westfield UTC. The area is convenient for an after-work stop from nearby offices or a drink before shopping and dinner.',
      'Because destinations are more spread out than in downtown neighborhoods, choose the venue first and confirm its deal window before dealing with evening traffic.',
    ],
    planningTip: 'Allow extra travel time during the weekday commute and check the venue’s location before choosing a mall parking structure.',
    nearby: ['Pacific Beach'],
  },
  {
    name: 'Harbor Island',
    slug: 'harbor-island',
    shortDescription: 'Find current Harbor Island happy hours with San Diego Bay views, including food and drink deals, weekday schedules, and venue details.',
    overview: [
      'Harbor Island is built around the view: restaurants along the waterfront look back toward downtown San Diego and the bay. It is a natural choice when scenery matters as much as the discount.',
      'There are fewer venues than in Little Italy or North Park, so reservations, current hours, and sunset timing matter more. Review the listing before making the trip.',
    ],
    planningTip: 'Plan around sunset, but arrive early enough to request outdoor or window seating and account for airport traffic.',
    nearby: ['Little Italy', 'Middletown', 'Gaslamp'],
  },
  {
    name: 'Middletown',
    slug: 'middletown',
    shortDescription: 'Explore happy hour deals in Middletown, San Diego near India Street and the airport.',
    overview: [
      'Middletown sits between Little Italy, Mission Hills, and the airport, with neighborhood restaurants that can be easier to reach than downtown during the evening rush. India Street is the area’s main dining corridor.',
      'The selection is compact, making it useful for a specific planned stop rather than a large bar crawl. Check each venue’s current weekday schedule and food specials below.',
    ],
    planningTip: 'India Street traffic can back up around commute time; the Middletown trolley station is useful for destinations on the lower corridor.',
    nearby: ['Little Italy', 'Harbor Island'],
  },
];

export function getNeighborhoodProfiles(): Array<NeighborhoodProfile & { venues: Venue[] }> {
  const venues = getVenues();
  return PROFILES.map((profile) => ({
    ...profile,
    venues: venues.filter((venue) => venue.neighborhood === profile.name && !venue.seoHidden),
  })).filter((profile) => profile.venues.length > 0);
}

export function getNeighborhoodByName(name: string): NeighborhoodProfile | undefined {
  return PROFILES.find((profile) => profile.name === name);
}

export function getNeighborhoodBySlug(slug: string): NeighborhoodProfile | undefined {
  return PROFILES.find((profile) => profile.slug === slug);
}

export function neighborhoodPath(name: string): string | undefined {
  const profile = getNeighborhoodByName(name);
  return profile ? `/neighborhoods/${profile.slug}/` : undefined;
}

export function neighborhoodSlug(name: string): string {
  return getNeighborhoodByName(name)?.slug || slugify(name);
}
