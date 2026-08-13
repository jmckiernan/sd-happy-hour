import type { AstroCookies } from 'astro';
import { createSession as createSessionRow, getSessionById, deleteSession as deleteSessionRow } from './store';

// Session storage backed by Postgres (README-NEON-MIGRATION.md §6 step 9 —
// everything else depends on this, so it migrates first). `sessions.expires_at`
// replaces the old Redis TTL (`{ ex: MAX_AGE_SECONDS }`); createSession/
// getSessionById/deleteSession in store.ts do the actual row-level work.

// Two kinds of session: the consumer account (Google/email) login, and a
// separate restaurant login (src/pages/api/restaurant/*.ts) used to claim a
// listing and toggle it live — see README-NOTIFICATIONS-SETUP.md. Admin
// privileges (submissions review, blog post generation) are granted based
// on whether a *user* session's email is in ADMIN_EMAILS (see
// lib/admins.ts), not a separate admin login.
export type SessionData = { role: 'user'; userId: string } | { role: 'restaurant'; restaurantId: string };

const MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours, matches the original

// Separate cookies per role so someone can be signed in as a consumer and
// as a restaurant at the same time in the same browser (plausible — a
// restaurant owner who also just wants to save their own favorite spots)
// without one login clobbering the other.
function cookieName(role: SessionData['role']) {
  return role === 'restaurant' ? 'sdhh_restaurant_session' : 'sdhh_session';
}

export async function createSession(cookies: AstroCookies, data: SessionData): Promise<string> {
  const subjectId = data.role === 'user' ? data.userId : data.restaurantId;
  const session = await createSessionRow(data.role, subjectId);
  cookies.set(cookieName(data.role), session.id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return session.id;
}

async function readSessionFromCookie(cookies: AstroCookies, name: string): Promise<SessionData | null> {
  const id = cookies.get(name)?.value;
  if (!id) return null;
  try {
    const row = await getSessionById(id);
    if (!row) return null;
    return row.role === 'user' ? { role: 'user', userId: row.userId! } : { role: 'restaurant', restaurantId: row.restaurantId! };
  } catch {
    // Transient store error — treat as "not signed in" rather than taking
    // down every page that checks auth status on load.
    return null;
  }
}

// Checks the consumer-account cookie first (the common case, and what every
// existing `session.role !== 'user'` check expects), falling back to the
// restaurant cookie so a restaurant-only visitor still gets *a* session
// back rather than null. Restaurant routes that need the restaurant session
// specifically (even when a user session also happens to be present)
// should use getRestaurantSession() instead.
export async function getSession(cookies: AstroCookies): Promise<SessionData | null> {
  return (await readSessionFromCookie(cookies, cookieName('user'))) ?? (await readSessionFromCookie(cookies, cookieName('restaurant')));
}

export async function getRestaurantSession(cookies: AstroCookies): Promise<Extract<SessionData, { role: 'restaurant' }> | null> {
  const data = await readSessionFromCookie(cookies, cookieName('restaurant'));
  return data?.role === 'restaurant' ? data : null;
}

export async function clearSession(cookies: AstroCookies, role: SessionData['role'] = 'user'): Promise<void> {
  const name = cookieName(role);
  const id = cookies.get(name)?.value;
  if (id) {
    try {
      await deleteSessionRow(id);
    } catch {
      // Logging out should never fail the request just because the store
      // is unreachable.
    }
  }
  cookies.delete(name, { path: '/' });
}
