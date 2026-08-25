import type { AstroCookies } from 'astro';
import { getSession } from './session';
import { getUserById, type User } from './store';
import { isAdminEmail } from './admins';
import { getVenueAccess, type VenueAccessRole } from './venueUsers';

// ---------------------------------------------------------------------------
// "May this request manage this venue?" — the single gate in front of every
// owner-facing write (listing edits, photos, menu).
//
// Two ways to pass: a *verified* claim on that specific venue, or an admin
// email. Anything else, including a pending or denied claim on the same
// venue, is refused. Note the check is per venue, not per user: holding a
// verified claim on one listing grants nothing anywhere else.
//
// Deliberately its own module rather than a branch inside admins.ts:
// getAdminUser() answers "is this one of the two site owners", which is a
// different question with a different blast radius, and conflating them is
// how a route ends up accidentally admin-gated or accidentally not.
// ---------------------------------------------------------------------------

export interface VenueManager {
  user: User;
  /** True when access came from an admin email rather than a claim. Routes use
   * this where owner and admin behaviour differ — e.g. an admin's photo upload
   * doesn't need automated screening to pass. */
  isAdmin: boolean;
  /** The verified claim that granted access, when it wasn't an admin. */
  claimId: string | null;
  accessRole: VenueAccessRole | 'site_admin';
}

export async function getVenueManager(cookies: AstroCookies, venueId: number): Promise<VenueManager | null> {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return null;

  const user = await getUserById(session.userId);
  if (!user) return null;

  if (isAdminEmail(user.email)) {
    return { user, isAdmin: true, claimId: null, accessRole: 'site_admin' };
  }

  const access = await getVenueAccess(user.id, venueId);
  if (access?.role === 'owner' || access?.role === 'full_admin') {
    return { user, isAdmin: false, claimId: access.claimId, accessRole: access.role };
  }

  return null;
}

/** The message every owner-facing route returns on a failed check. Vague on
 * purpose: it doesn't distinguish "not signed in" from "not your venue", so a
 * probe can't enumerate which venues are claimed. */
export const NOT_A_MANAGER_MESSAGE =
  'You need owner or Full Admin access to manage this listing.';
