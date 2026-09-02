/**
 * Shared browser fetch for /api/account/me so nav, account, and gated pages
 * agree on session state (no-store + credentials). Retries only on soft
 * failures so signed-out visitors are not delayed.
 */

export interface BrowserSession {
  authenticated: boolean;
  user: any | null;
  isAdmin: boolean;
}

const SIGNED_OUT: BrowserSession = { authenticated: false, user: null, isAdmin: false };

type FetchAttempt =
  | { ok: true; session: BrowserSession }
  | { ok: false; softFailure: boolean };

async function fetchOnce(): Promise<FetchAttempt> {
  try {
    const res = await fetch('/api/account/me', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'cache-control': 'no-cache', accept: 'application/json' },
    });
    if (res.status >= 500) return { ok: false, softFailure: true };
    if (!res.ok) return { ok: true, session: SIGNED_OUT };
    const body = await res.json();
    if (!body?.authenticated) return { ok: true, session: SIGNED_OUT };
    return {
      ok: true,
      session: {
        authenticated: true,
        user: body.user ?? null,
        isAdmin: Boolean(body.isAdmin),
      },
    };
  } catch {
    return { ok: false, softFailure: true };
  }
}

export async function fetchBrowserSession(): Promise<BrowserSession> {
  const first = await fetchOnce();
  if (first.ok) return first.session;
  if (!first.softFailure) return SIGNED_OUT;

  // One retry covers a transient store blip without treating a definitive
  // signed-out response as "try again".
  await new Promise((resolve) => window.setTimeout(resolve, 120));
  const second = await fetchOnce();
  return second.ok ? second.session : SIGNED_OUT;
}
