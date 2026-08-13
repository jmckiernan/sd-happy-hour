import type { AstroCookies } from 'astro';
import { createSession as createSessionRow, getSessionById, deleteSession as deleteSessionRow } from './store';

// Session storage backed by Postgres. `sessions.expires_at` replaces the old
// Redis TTL; createSession/getSessionById/deleteSession in store.ts do the
// actual row-level work.
//
// Single role now (2026-08-12 restaurant sign-in redesign): restaurants no
// longer have a separate login — anyone signed in here as a regular user
// can hold venue claims (see store.ts's VenueClaim). The old two-cookie,
// two-role system (a person could be signed in as a consumer *and* a
// restaurant at once) is gone; `sessions.restaurant_id` was dropped in
// migrations/0002_venue_claims.sql.
export interface SessionData {
  role: 'user';
  userId: string;
}

const MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours, matches the original
const COOKIE_NAME = 'sdhh_session';

export async function createSession(cookies: AstroCookies, userId: string): Promise<string> {
  const session = await createSessionRow('user', userId);
  cookies.set(COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return session.id;
}

export async function getSession(cookies: AstroCookies): Promise<SessionData | null> {
  const id = cookies.get(COOKIE_NAME)?.value;
  if (!id) return null;
  try {
    const row = await getSessionById(id);
    if (!row || !row.userId) return null;
    return { role: 'user', userId: row.userId };
  } catch {
    // Transient store error — treat as "not signed in" rather than taking
    // down every page that checks auth status on load.
    return null;
  }
}

export async function clearSession(cookies: AstroCookies): Promise<void> {
  const id = cookies.get(COOKIE_NAME)?.value;
  if (id) {
    try {
      await deleteSessionRow(id);
    } catch {
      // Logging out should never fail the request just because the store
      // is unreachable.
    }
  }
  cookies.delete(COOKIE_NAME, { path: '/' });
}
