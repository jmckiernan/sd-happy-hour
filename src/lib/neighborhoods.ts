import { getVenues, slugify, type Venue } from './venues';

export interface NeighborhoodProfile {
  name: string;
  slug: string;
  shortDescription: string;
  overview: string[];
  planningTip: string;
  nearby: string[];
}

type ProfileSeed = Omit<NeighborhoodProfile, 'name' | 'slug'>;

const DETAILED: Record<string, ProfileSeed> = {
  'Little Italy': {
    shortDescription: 'Compare current happy hour times and deals at bars and restaurants in Little Italy, San Diego.',
    overview: [
      'Little Italy is one of San Diego’s easiest neighborhoods for planning a happy hour on foot. India Street and Kettner Boulevard put seafood bars, cocktail rooms, patios, and chef-driven restaurants within a compact downtown grid.',
      'Weekday deals here tend to start in the mid-afternoon and fill quickly as the dinner crowd arrives. Compare each listing’s current days, times, and menu highlights before choosing a starting point.',
    ],
    planningTip: 'For Thursday or Friday, arrive before 5 PM and use the Waterfront Park or Little Italy trolley stops to avoid circling for street parking.',
    nearby: ['Gaslamp', 'Middletown', 'Embarcadero'],
  },
  'North Park': {
    shortDescription: 'Find North Park happy hours for craft cocktails, beer, appetizers, and casual group nights in San Diego.',
    overview: [
      'North Park’s happy hour scene clusters around University Avenue and 30th Street, with a mix of cocktail bars, breweries, gastropubs, and game rooms. It works especially well when a group wants options without committing to a formal dinner.',
      'Many venues are walkable from the neighborhood’s central blocks, but their deal windows and available days vary. Use the listings below to compare the current schedule before building a crawl.',
    ],
    planningTip: 'Park once near University Avenue and 30th Street or use a rideshare; the central venues are close enough to visit on foot.',
    nearby: ['Normal Heights', 'South Park', 'Hillcrest'],
  },
  'South Park': {
    shortDescription: 'Explore South Park, San Diego happy hours at neighborhood wine bars, cocktail spots, and patios.',
    overview: [
      'South Park has a smaller, more residential happy hour scene than downtown, which is part of its appeal. Independent wine bars, distinctive cocktail rooms, and patios sit along walkable stretches near 30th Street.',
      'It is a good fit for a low-key date or a neighborhood meet-up. Check the day-by-day schedule below because several South Park deals end before the later dinner rush.',
    ],
    planningTip: 'Street parking is easiest earlier in the afternoon; once you arrive, the main 30th Street corridor is best explored on foot.',
    nearby: ['North Park', 'Gaslamp', 'Normal Heights'],
  },
  'Pacific Beach': {
    shortDescription: 'Find Pacific Beach happy hours with drink specials, discounted appetizers, patios, and beach-area bars.',
    overview: [
      'Pacific Beach pairs casual bars and restaurants with an easy pre- or post-beach stop. Grand Avenue, Garnet Avenue, and the streets near the boardwalk cover everything from house beer specials to patio appetizers.',
      'The neighborhood gets busiest near sunset and on weekends, while many traditional happy hours remain weekday-only. Confirm the listed days and end time before heading toward the coast.',
    ],
    planningTip: 'Expect slower traffic and limited parking near the water around sunset; arrive early or use a rideshare if timing matters.',
    nearby: ['Mission Beach', 'Ocean Beach', 'La Jolla'],
  },
  Gaslamp: {
    shortDescription: 'Compare Gaslamp Quarter happy hours at downtown San Diego rooftops, restaurants, and bars.',
    overview: [
      'The Gaslamp Quarter is downtown San Diego’s high-energy option for rooftop drinks, group outings, and a happy hour that can roll into dinner or a night out. Fifth Avenue has the densest concentration of choices.',
      'Downtown event schedules can change how crowded the neighborhood feels, so compare current venue times and check the Padres or convention calendar when you are making a plan.',
    ],
    planningTip: 'Use the trolley when Petco Park or the Convention Center has a major event; downtown parking prices can rise quickly.',
    nearby: ['Little Italy', 'East Village', 'Embarcadero'],
  },
  UTC: {
    shortDescription: 'Discover current UTC and University City happy hours near Westfield UTC, with San Diego drink specials, food deals, days, and times.',
    overview: [
      'UTC and University City offer polished restaurants and cocktail bars around La Jolla Village Drive and Westfield UTC. The area is convenient for an after-work stop from nearby offices or a drink before shopping and dinner.',
      'Because destinations are more spread out than in downtown neighborhoods, choose the venue first and confirm its deal window before dealing with evening traffic.',
    ],
    planningTip: 'Allow extra travel time during the weekday commute and check the venue’s location before choosing a mall parking structure.',
    nearby: ['La Jolla', 'Carmel Valley', 'Sorrento Valley'],
  },
  'Harbor Island': {
    shortDescription: 'Find current Harbor Island happy hours with San Diego Bay views, including food and drink deals, weekday schedules, and venue details.',
    overview: [
      'Harbor Island is built around the view: restaurants along the waterfront look back toward downtown San Diego and the bay. It is a natural choice when scenery matters as much as the discount.',
      'There are fewer venues than in Little Italy or North Park, so reservations, current hours, and sunset timing matter more. Review the listing before making the trip.',
    ],
    planningTip: 'Plan around sunset, but arrive early enough to request outdoor or window seating and account for airport traffic.',
    nearby: ['Little Italy', 'Embarcadero', 'Point Loma'],
  },
  Middletown: {
    shortDescription: 'Explore happy hour deals in Middletown, San Diego near India Street and the airport.',
    overview: [
      'Middletown sits between Little Italy, Mission Hills, and the airport, with neighborhood restaurants that can be easier to reach than downtown during the evening rush. India Street is the area’s main dining corridor.',
      'The selection is compact, making it useful for a specific planned stop rather than a large bar crawl. Check each venue’s current weekday schedule and food specials below.',
    ],
    planningTip: 'India Street traffic can back up around commute time; the Middletown trolley station is useful for destinations on the lower corridor.',
    nearby: ['Little Italy', 'Old Town', 'Hillcrest'],
  },
  'La Jolla': {
    shortDescription: 'Find La Jolla happy hours with coastal views, wine bars, seafood spots, and weekday drink specials.',
    overview: [
      'La Jolla combines upscale dining with ocean views, making happy hour a popular pre-dinner stop along Prospect Street and the village core. Expect a mix of wine bars, seafood restaurants, and hotel lounges.',
      'Parking and traffic tighten on sunny afternoons, so confirm each venue’s deal window and whether patio seating is first-come.',
    ],
    planningTip: 'Arrive before the late-afternoon rush if you want a window table, or plan around the UTC trolley and a short rideshare into the village.',
    nearby: ['UTC', 'Del Mar', 'Pacific Beach'],
  },
  Hillcrest: {
    shortDescription: 'Browse Hillcrest happy hours at San Diego’s walkable dining district with cocktails, wine, and patio deals.',
    overview: [
      'Hillcrest is one of San Diego’s most walkable happy hour neighborhoods, centered on University Avenue and Fifth Avenue. The mix spans LGBTQ-friendly bars, wine rooms, and chef-driven restaurants.',
      'Many deals run on weekdays only and end before the dinner rush, so compare start times before planning a crawl.',
    ],
    planningTip: 'Street parking fills quickly after work; the Hillcrest trolley stop puts you within a few blocks of most listings.',
    nearby: ['North Park', 'Normal Heights', 'Mission Valley'],
  },
  'Ocean Beach': {
    shortDescription: 'Find Ocean Beach happy hours with casual beach bars, Newport Avenue spots, and sunset-friendly patios.',
    overview: [
      'Ocean Beach keeps things relaxed: Newport Avenue and the pier area offer casual bars, breweries, and restaurants with straightforward drink and appetizer specials.',
      'Weekend crowds pick up near sunset, but weekday happy hours are often the best value and easiest parking.',
    ],
    planningTip: 'Expect tight parking on sunny weekend afternoons; weekday happy hours are easier to reach and usually less crowded.',
    nearby: ['Point Loma', 'Mission Beach', 'Pacific Beach'],
  },
  'Point Loma': {
    shortDescription: 'Explore Point Loma and Liberty Station happy hours with harbor views, breweries, and waterfront dining.',
    overview: [
      'Point Loma and Liberty Station combine harbor views with breweries, seafood spots, and converted naval-base dining. Happy hours here work well as a destination stop rather than a dense bar crawl.',
      'Venues are spread across Liberty Station, Rosecrans, and the harborfront, so pick a starting point and confirm deal times before driving between clusters.',
    ],
    planningTip: 'Liberty Station has centralized parking; harborfront spots fill up around sunset on clear days.',
    nearby: ['Ocean Beach', 'Old Town', 'Harbor Island'],
  },
  'Mission Valley': {
    shortDescription: 'Compare Mission Valley happy hours near Fashion Valley, Hotel Circle, and central San Diego dining.',
    overview: [
      'Mission Valley is a practical happy hour choice when you need something central and easy to reach from multiple parts of the city. Hotel Circle and Fashion Valley area restaurants offer weekday drink and appetizer deals.',
      'The neighborhood is car-friendly but spread out, so choose a venue first rather than planning a walkable crawl.',
    ],
    planningTip: 'Hotel Circle venues often have dedicated parking; allow extra time when Friars Road traffic is heavy.',
    nearby: ['Hillcrest', 'Old Town', 'Kearny Mesa'],
  },
  'Old Town': {
    shortDescription: 'Find Old Town San Diego happy hours with Mexican restaurants, margarita specials, and historic-district patios.',
    overview: [
      'Old Town is San Diego’s historic heart, with Mexican restaurants and margarita-forward happy hours along San Diego Avenue and the state historic park area.',
      'It is popular with visitors on weekends, but weekday afternoon deals can be easier to reach and less crowded.',
    ],
    planningTip: 'Old Town transit center makes this an easy trolley stop; parking lots fill on weekend afternoons.',
    nearby: ['Mission Valley', 'Point Loma', 'Middletown'],
  },
  Carlsbad: {
    shortDescription: 'Browse Carlsbad happy hours with coastal dining, breweries, and north county drink specials.',
    overview: [
      'Carlsbad stretches from the village and waterfront to inland shopping districts, with happy hours at breweries, seafood restaurants, and hotel bars throughout.',
      'Venues are spread across the city, so check the address and deal times before heading out.',
    ],
    planningTip: 'Coastal Carlsbad traffic peaks on weekend afternoons; inland spots along the 78 corridor are often easier to reach on weekdays.',
    nearby: ['Encinitas', 'Oceanside', 'Del Mar'],
  },
  Encinitas: {
    shortDescription: 'Find Encinitas happy hours along the coast and Highway 101 with casual bars and seafood spots.',
    overview: [
      'Encinitas mixes surf-town bars, coastal restaurants, and inland dining along El Camino Real. Happy hours range from taco-and-margarita deals to craft beer specials.',
      'Coastal venues get busy near sunset; confirm whether deals apply on weekends before you go.',
    ],
    planningTip: 'Coastal parking is tight on sunny days; consider the Encinitas transit stop for venues near the 101.',
    nearby: ['Solana Beach', 'Carlsbad', 'Del Mar'],
  },
  'Del Mar': {
    shortDescription: 'Explore Del Mar happy hours with upscale coastal dining, wine bars, and fairgrounds-area restaurants.',
    overview: [
      'Del Mar offers a polished happy hour scene near the coast and Del Mar Heights, with wine bars, seafood restaurants, and hotel lounges.',
      'Racing season and summer weekends can add traffic near the fairgrounds and beach, so confirm venue hours in advance.',
    ],
    planningTip: 'Allow extra time during Del Mar racing season and summer beach traffic.',
    nearby: ['Solana Beach', 'La Jolla', 'Encinitas'],
  },
  Oceanside: {
    shortDescription: 'Find Oceanside happy hours with beach bars, harbor dining, and north county drink specials.',
    overview: [
      'Oceanside covers the pier, harbor, and inland dining corridors with casual bars, breweries, and waterfront restaurants offering weekday happy hours.',
      'Venues range from walkable pier-area spots to spread-out inland locations, so check each listing’s address before planning.',
    ],
    planningTip: 'The Oceanside transit center connects to coastal venues; pier-area parking fills on summer weekends.',
    nearby: ['Carlsbad', 'Vista', 'San Clemente'],
  },
  Coronado: {
    shortDescription: 'Browse Coronado happy hours with island dining, bay views, and Hotel del Coronado-area bars.',
    overview: [
      'Coronado’s happy hour scene centers on Orange Avenue and the resort corridor, with bay views and a slower pace than downtown San Diego.',
      'The bridge and ferry access mean timing matters during events and summer weekends.',
    ],
    planningTip: 'Bridge traffic can spike on summer evenings; the ferry from downtown is an alternative for bay-side venues.',
    nearby: ['Embarcadero', 'Point Loma', 'Gaslamp'],
  },
  'Chula Vista': {
    shortDescription: 'Find Chula Vista happy hours in south bay restaurants, breweries, and bayfront dining.',
    overview: [
      'Chula Vista offers south bay happy hours from Third Avenue dining to eastlake and bayfront spots. The mix includes Mexican restaurants, breweries, and family-friendly chains with weekday deals.',
      'Distances between clusters can be significant, so pick a venue area before you drive.',
    ],
    planningTip: 'Third Avenue and Otay Ranch have different traffic patterns; check the venue address before choosing a route.',
    nearby: ['National City', 'Imperial Beach', 'La Mesa'],
  },
};

const NEARBY: Record<string, string[]> = {
  'Normal Heights': ['North Park', 'Hillcrest', 'Kearny Mesa'],
  'Mission Beach': ['Pacific Beach', 'Ocean Beach', 'La Jolla'],
  'Kearny Mesa': ['Clairemont', 'Mission Valley', 'UTC'],
  Clairemont: ['Kearny Mesa', 'Pacific Beach', 'Mira Mesa'],
  'Carmel Valley': ['Del Mar', 'UTC', 'Sorrento Valley'],
  'Sorrento Valley': ['UTC', 'Carmel Valley', 'Mira Mesa'],
  'Mira Mesa': ['Scripps Ranch', 'Kearny Mesa', 'Rancho Bernardo'],
  'Rancho Bernardo': ['Poway', 'Mira Mesa', 'Escondido'],
  'Rancho Peñasquitos': ['Rancho Bernardo', 'Carmel Valley', 'Sorrento Valley'],
  'Scripps Ranch': ['Mira Mesa', 'Rancho Bernardo', 'Poway'],
  'San Carlos': ['La Mesa', 'El Cajon', 'Mission Valley'],
  'La Mesa': ['El Cajon', 'San Carlos', 'Chula Vista'],
  'El Cajon': ['La Mesa', 'Santee', 'Spring Valley'],
  Escondido: ['San Marcos', 'Vista', 'Rancho Bernardo'],
  'San Marcos': ['Escondido', 'Vista', 'Carlsbad'],
  Vista: ['Oceanside', 'San Marcos', 'Carlsbad'],
  Poway: ['Rancho Bernardo', 'Scripps Ranch', 'Santee'],
  'Solana Beach': ['Del Mar', 'Encinitas', 'Carlsbad'],
  'Imperial Beach': ['Chula Vista', 'Coronado', 'Point Loma'],
  Temecula: ['Fallbrook', 'Escondido', 'Vista'],
  'San Clemente': ['Oceanside', 'Carlsbad', 'Encinitas'],
  Embarcadero: ['Gaslamp', 'Little Italy', 'Coronado'],
  'East Village': ['Gaslamp', 'Little Italy', 'Balboa Park'],
  'Balboa Park': ['Hillcrest', 'East Village', 'Mission Valley'],
  Tijuana: ['Imperial Beach', 'Chula Vista', 'Coronado'],
  Bonsall: ['Oceanside', 'Fallbrook', 'Vista'],
  Fallbrook: ['Oceanside', 'Temecula', 'Bonsall'],
  Ramona: ['Poway', 'El Cajon', 'Santee'],
  Santee: ['El Cajon', 'La Mesa', 'Poway'],
  'Spring Valley': ['La Mesa', 'El Cajon', 'Chula Vista'],
  Alpine: ['El Cajon', 'La Mesa', 'Poway'],
  Lakeside: ['El Cajon', 'Santee', 'Spring Valley'],
  'College Area': ['North Park', 'La Mesa', 'Mission Valley'],
  'City Heights': ['North Park', 'Normal Heights', 'Mission Valley'],
  'Lemon Grove': ['La Mesa', 'Spring Valley', 'Chula Vista'],
  Jamul: ['Chula Vista', 'Spring Valley', 'El Cajon'],
  'Rancho Santa Fe': ['Del Mar', 'Solana Beach', 'Encinitas'],
  'Valley Center': ['Escondido', 'Fallbrook', 'Ramona'],
};

const ALL_NEIGHBORHOODS = [
  'Little Italy', 'Gaslamp', 'Embarcadero', 'East Village', 'Balboa Park', 'Harbor Island', 'Middletown',
  'Hillcrest', 'North Park', 'Normal Heights', 'South Park', 'Mission Valley', 'Old Town', 'Point Loma',
  'Ocean Beach', 'Mission Beach', 'Pacific Beach', 'La Jolla', 'UTC', 'Carmel Valley', 'Sorrento Valley',
  'Kearny Mesa', 'Clairemont', 'Mira Mesa', 'Rancho Bernardo', 'Rancho Peñasquitos', 'Scripps Ranch',
  'San Carlos', 'College Area', 'City Heights',
  'Carlsbad', 'Encinitas', 'Del Mar', 'Solana Beach', 'Oceanside', 'Vista', 'San Marcos', 'Escondido',
  'Poway', 'Fallbrook', 'Bonsall', 'Ramona', 'Temecula', 'San Clemente',
  'Coronado', 'Imperial Beach', 'Chula Vista', 'La Mesa', 'El Cajon', 'Santee', 'Spring Valley',
  'Alpine', 'Lakeside', 'Lemon Grove', 'Jamul', 'Rancho Santa Fe', 'Valley Center', 'Tijuana',
];

function basicProfile(name: string): ProfileSeed {
  const nearby = NEARBY[name] || [];
  return {
    shortDescription: `Find ${name} happy hours with current drink specials, food deals, days, and times in San Diego County.`,
    overview: [
      `${name} has bars and restaurants offering weekday happy hour drink and food specials. Compare current schedules, deal highlights, and venue details below before you go.`,
      `Happy hour days and end times vary by venue, so confirm the listing before building your plan.`,
    ],
    planningTip: 'Check each venue’s current happy hour window before heading out, especially on weekends when schedules can change.',
    nearby,
  };
}

function buildProfile(name: string): NeighborhoodProfile {
  const seed = DETAILED[name] || basicProfile(name);
  return {
    name,
    slug: slugify(name),
    ...seed,
  };
}

const PROFILES: NeighborhoodProfile[] = ALL_NEIGHBORHOODS.map(buildProfile);

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

export function getAllNeighborhoodNames(): string[] {
  return ALL_NEIGHBORHOODS;
}
