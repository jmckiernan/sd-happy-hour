import type { AstroCookies } from 'astro';
import { getSession } from './session';
import { getUserById, type User } from './store';
import { getVenueOwner } from './venueUsers';

export async function getSignedInVenueOwner(cookies: AstroCookies, venueId: number): Promise<User | null> {
  const session = await getSession(cookies);
  if (!session) return null;
  const owner = await getVenueOwner(venueId);
  if (!owner || owner.user_id !== session.userId) return null;
  return getUserById(session.userId);
}
