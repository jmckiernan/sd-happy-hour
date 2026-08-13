import type { APIRoute } from 'astro';
import { getLiveOverrides } from '../../lib/store';
import { json } from '../../lib/api';

export const prerender = false;

// Public, no-login-needed list of venue IDs currently live via a
// restaurant's manual "we're live now" toggle. getLiveOverrides() already
// filters to active, unexpired rows in SQL, so callers never have to check
// expiresAt themselves. The homepage merges this with its own
// schedule-based live check so a manual override shows the same "Live Now"
// badge as a scheduled one.
export const GET: APIRoute = async () => {
  const overrides = await getLiveOverrides();
  const liveVenueIds = Object.keys(overrides).map(Number);
  return json({ liveVenueIds });
};
