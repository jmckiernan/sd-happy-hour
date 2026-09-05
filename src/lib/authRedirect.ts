/**
 * Same-origin post-auth redirects for /account/?next=…
 * Rejects absolute URLs, protocol-relative URLs, and backslash tricks.
 */

const ACCOUNT_HREF = '/account/';

function isAccountSignInPath(path: string): boolean {
  try {
    const url = new URL(path, 'https://sdhh.local');
    return url.pathname === '/account' || url.pathname === '/account/';
  } catch {
    return false;
  }
}

export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Only relative paths on this origin. Reject before decoding so `%2F%2Fevil`
  // cannot slip through as `//evil`.
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return null;
  }
  if (trimmed.includes('://')) return null;

  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return null;
  }

  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\')) {
    return null;
  }
  if (decoded.includes('://')) return null;

  try {
    const url = new URL(decoded, 'https://sdhh.local');
    if (url.origin !== 'https://sdhh.local') return null;
    const path = `${url.pathname}${url.search}${url.hash}`;
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Destination after a successful sign-in. Unwraps nested `/account/?next=…`
 * values and rejects the account/sign-in page itself so auth never self-loops.
 */
export function postAuthReturnPath(raw: string | null | undefined): string | null {
  let current = safeReturnPath(raw);
  const seen = new Set<string>();

  while (current && isAccountSignInPath(current)) {
    if (seen.has(current)) return null;
    seen.add(current);

    let nested: string | null = null;
    try {
      nested = new URL(current, 'https://sdhh.local').searchParams.get('next');
    } catch {
      return null;
    }
    current = safeReturnPath(nested);
  }

  return current;
}

/**
 * Default destination for a restaurant owner after sign-in. Claims are ordered
 * by the store, so multi-venue owners land on their most recently claimed
 * verified venue while the dashboard's venue switcher keeps the rest handy.
 */
export function verifiedOwnerDashboardPath(
  claims: Array<{ status?: string | null; venueId?: number | null }> | null | undefined
): string | null {
  const claim = claims?.find(({ status, venueId }) =>
    status === 'verified' && Number.isSafeInteger(venueId) && Number(venueId) > 0
  );
  return claim ? `/restaurant/?venueId=${claim.venueId}` : null;
}

/** Preserve an intentional gated-page return before applying a role default. */
export function postLoginDestination(
  requestedReturnPath: string | null | undefined,
  roleDefaultPath: string | null | undefined
): string | null {
  return postAuthReturnPath(requestedReturnPath) || postAuthReturnPath(roleDefaultPath);
}

/** Build /account/ or /account/?next=… for a safe same-origin return path. */
export function accountSignInHref(returnTo?: string | null): string {
  const next = postAuthReturnPath(returnTo);
  if (!next) return ACCOUNT_HREF;
  return `${ACCOUNT_HREF}?next=${encodeURIComponent(next)}`;
}

/** Path + query + hash for the current browser location (client only). */
export function currentReturnPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}
