import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { getKv, isKvConfigured, readLocal, writeLocal } from './kv';

// Session storage backed by Vercel KV (with a TTL) in production. In local
// dev without KV configured, this falls back to a local JSON file — see
// the comment in kv.ts for why that's fine locally but not once deployed.

export type SessionData =
  | { role: 'user'; userId: string }
  | { role: 'admin'; username: string };

const COOKIE_NAME = 'sdhh_session';
const MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours, matches the original

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
  cookies.set(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  return id;
}

export async function getSession(cookies: AstroCookies): Promise<SessionData | null> {
  const id = cookies.get(COOKIE_NAME)?.value;
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

export async function clearSession(cookies: AstroCookies): Promise<void> {
  const id = cookies.get(COOKIE_NAME)?.value;
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
  cookies.delete(COOKIE_NAME, { path: '/' });
}
