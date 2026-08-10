import type { APIRoute } from 'astro';
import { readLiveOverrides } from '../../lib/kv';
import { json } from '../../lib/api';

export const prerender = false;

// Public, no-login-needed list of venue IDs currently live via a
// restaurant's manual "we're live now" toggle (expired overrides are
// filtered out here so callers never have to check expiresAt themselves).
// The homepage merges this with its own schedule-based live check so a
// manual override shows the same "Live Now" badge as a scheduled one.
export const GET: APIRoute = async () => {
  const overrides = await readLiveOverrides();
  const now = Date.now();
  const liveVenueIds = Object.entries(overrides)
    .filter(([, override]) => override.active && new Date(override.expiresAt).getTime() > now)
    .map(([venueId]) => Number(venueId));
  return json({ liveVenueIds });
};
