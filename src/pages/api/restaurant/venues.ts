import type { APIRoute } from 'astro';
import { json } from '../../../lib/api';
import { getVenues } from '../../../lib/venues';
import { listVerifiedClaimedVenueIds } from '../../../lib/store';
import { venueSearchScore } from '../../../lib/venueSearch';

export const prerender = false;

// Search venues to claim (restaurant dashboard's "claim your listing"
// panel). No login required to search — only to actually submit a claim
// (POST /api/restaurant/claim) — but results flag venues that already have
// a verified claimant, so the UI can show "already claimed" instead of
// letting someone waste a claim attempt on it.
export const GET: APIRoute = async ({ url }) => {
  const query = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!query) return json({ venues: [] });

  const matches = getVenues()
    .map((v) => ({ venue: v, score: venueSearchScore(v, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.venue.name.localeCompare(b.venue.name))
    .slice(0, 8)
    .map((row) => row.venue);
  if (!matches.length) return json({ venues: [] });

  const claimedIds = await listVerifiedClaimedVenueIds();
  const venues = matches.map((v) => ({
    id: v.id,
    name: v.name,
    neighborhood: v.neighborhood,
    address: v.address,
    alreadyClaimed: claimedIds.has(v.id),
    listingStatus: v.listingStatus || 'published',
    hasHappyHourData: Boolean(v.hasHappyHourData),
  }));
  return json({ venues });
};
