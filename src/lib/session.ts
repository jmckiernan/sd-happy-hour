import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { getKv, isKvConfigured, readLocal, writeLocal } from './kv';

// Session storage backed by Vercel KV (with a TTL) in production. In local
// dev without KV configured, this falls back to a local JSON file — see
// the comment in kv.ts for why that's fine locally but not once deployed.

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

function sessionKey(id: string) {
  return `sdhh:session:${id}`;
}

type LocalSessions = Record<string, { data: SessionData; expiresAt: number }>;

async function readLocalSession(id: string): Promise<SessionData | null> {
  const sessions = await readLocal<LocalSessions>('sessions', {});
  const entry = sessions[id];
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    delete sessions[id];
    await writeLocal('sessions', sessions);
    return null;
  }
  return entry.data;
}

async function writeLocalSession(id: string, data: SessionData): Promise<void> {
  const sessions = await readLocal<LocalSessions>('sessions', {});
  sessions[id] = { data, expiresAt: Date.now() + MAX_AGE_SECONDS * 1000 };
  await writeLocal('sessions', sessions);
}

async function deleteLocalSession(id: string): Promise<void> {
  const sessions = await readLocal<LocalSessions>('sessions', {});
  if (id in sessions) {
    delete sessions[id];
    await writeLocal('sessions', sessions);
  }
}

export async function createSession(cookies: AstroCookies, data: SessionData): Promise<string> {
  const id = crypto.randomBytes(32).toString('hex');
  if (isKvConfigured()) {
    await getKv().set(sessionKey(id), data, { ex: MAX_AGE_SECONDS });
  } else {
    await writeLocalSession(id, data);
  }
  cookies.set(cookieName(data.role), id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return id;
}

async function readSessionFromCookie(cookies: AstroCookies, name: string): Promise<SessionData | null> {
  const id = cookies.get(name)?.value;
  if (!id) return null;
  try {
    if (isKvConfigured()) {
      const data = await getKv().get<SessionData>(sessionKey(id));
      return data ?? null;
    }
    return await readLocalSession(id);
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
      if (isKvConfigured()) {
        await getKv().del(sessionKey(id));
      } else {
        await deleteLocalSession(id);
      }
    } catch {
      // Logging out should never fail the request just because the store
      // is unreachable.
    }
  }
  cookies.delete(name, { path: '/' });
}
