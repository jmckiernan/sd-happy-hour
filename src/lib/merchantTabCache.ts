/**
 * Browser cache for merchant workspace tab API JSON (stale-while-revalidate).
 * Memory + sessionStorage, keyed by venueId + resource (+ optional suffix).
 */

export type MerchantTabResource =
  | 'claims'
  | 'promotions'
  | 'listing'
  | 'photos'
  | 'menu'
  | 'audience'
  | 'reports'
  | 'schedule'
  | 'billing'
  | 'team';

/** Soft TTL: entries older than this are still returned as stale for SWR. */
export const MERCHANT_TAB_CACHE_TTL_MS = 10 * 60 * 1000;

/** Account-scoped caches (claims) use venueId 0. */
export const MERCHANT_TAB_CACHE_ACCOUNT_VENUE = 0;

const STORAGE_PREFIX = 'sdhh:merchant-tab:';
const memory = new Map<string, string>();

export interface MerchantTabCacheMeta {
  cachedAt: number;
  stale: boolean;
  ageMs: number;
}

export interface MerchantTabCacheHit<T> extends MerchantTabCacheMeta {
  data: T;
}

interface StoredEnvelope {
  v: 1;
  venueId: number;
  resource: string;
  suffix: string;
  cachedAt: number;
  data: unknown;
}

function storageKey(venueId: number, resource: string, suffix = ''): string {
  const safeSuffix = suffix ? `:${suffix}` : '';
  return `${STORAGE_PREFIX}${venueId}:${resource}${safeSuffix}`;
}

function nowMs(): number {
  return Date.now();
}

function readRaw(key: string): string | null {
  const mem = memory.get(key);
  if (mem != null) return mem;
  try {
    const stored = sessionStorage.getItem(key);
    if (stored != null) memory.set(key, stored);
    return stored;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  memory.set(key, value);
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Quota / private mode — memory still serves the session.
  }
}

function removeRaw(key: string): void {
  memory.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function parseEnvelope(raw: string): StoredEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as StoredEnvelope;
    if (!parsed || parsed.v !== 1 || typeof parsed.cachedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Stable-enough equality for JSON API payloads. */
export function merchantTabCacheEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function getMerchantTabCache<T>(
  venueId: number,
  resource: MerchantTabResource | string,
  options?: { suffix?: string; maxAgeMs?: number },
): MerchantTabCacheHit<T> | null {
  const key = storageKey(venueId, resource, options?.suffix);
  const raw = readRaw(key);
  if (!raw) return null;
  const envelope = parseEnvelope(raw);
  if (!envelope || envelope.venueId !== venueId || envelope.resource !== resource) {
    removeRaw(key);
    return null;
  }
  const ageMs = nowMs() - envelope.cachedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    removeRaw(key);
    return null;
  }
  const maxAge = options?.maxAgeMs ?? MERCHANT_TAB_CACHE_TTL_MS;
  return {
    data: envelope.data as T,
    cachedAt: envelope.cachedAt,
    ageMs,
    stale: ageMs > maxAge,
  };
}

export function setMerchantTabCache(
  venueId: number,
  resource: MerchantTabResource | string,
  data: unknown,
  options?: { suffix?: string },
): void {
  const suffix = options?.suffix || '';
  const key = storageKey(venueId, resource, suffix);
  const envelope: StoredEnvelope = {
    v: 1,
    venueId,
    resource,
    suffix,
    cachedAt: nowMs(),
    data,
  };
  try {
    writeRaw(key, JSON.stringify(envelope));
  } catch {
    // Circular / non-JSON — skip persistence.
  }
}

export function invalidateMerchantTabCache(
  venueId: number,
  resource?: MerchantTabResource | string,
  options?: { suffix?: string },
): void {
  if (resource) {
    removeRaw(storageKey(venueId, resource, options?.suffix));
    return;
  }
  const prefix = `${STORAGE_PREFIX}${venueId}:`;
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) removeRaw(key);
  }
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(prefix)) removeRaw(key);
    }
  } catch {
    /* ignore */
  }
}

export function invalidateAllMerchantTabCache(): void {
  for (const key of [...memory.keys()]) {
    if (key.startsWith(STORAGE_PREFIX)) memory.delete(key);
  }
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

export interface SwrMerchantTabOptions<T> {
  venueId: number;
  resource: MerchantTabResource | string;
  suffix?: string;
  maxAgeMs?: number;
  signal?: AbortSignal;
  fetcher: () => Promise<T>;
  /** Paint immediately when a cache entry exists (including stale). */
  onCached?: (data: T, meta: MerchantTabCacheMeta) => void;
  /** Called after network with the fresh payload. */
  onFresh?: (data: T, meta: { changed: boolean; fromCache: boolean }) => void;
  /** Network failure. `hadCache` means UI may already show cached data. */
  onError?: (error: unknown, meta: { hadCache: boolean }) => void;
}

/**
 * Stale-while-revalidate: optional instant paint from cache, always revalidate.
 * Returns the fresh data when the network succeeds; null if aborted before finish.
 */
export async function swrMerchantTabCache<T>(
  options: SwrMerchantTabOptions<T>,
): Promise<{ data: T; changed: boolean; fromCache: boolean } | null> {
  const hit = getMerchantTabCache<T>(options.venueId, options.resource, {
    suffix: options.suffix,
    maxAgeMs: options.maxAgeMs,
  });
  const hadCache = Boolean(hit);
  if (hit) {
    options.onCached?.(hit.data, {
      cachedAt: hit.cachedAt,
      stale: hit.stale,
      ageMs: hit.ageMs,
    });
  }

  try {
    const fresh = await options.fetcher();
    if (options.signal?.aborted) return null;
    const changed = !hit || !merchantTabCacheEqual(hit.data, fresh);
    setMerchantTabCache(options.venueId, options.resource, fresh, { suffix: options.suffix });
    options.onFresh?.(fresh, { changed, fromCache: hadCache });
    return { data: fresh, changed, fromCache: hadCache };
  } catch (error) {
    if (options.signal?.aborted) return null;
    options.onError?.(error, { hadCache });
    throw error;
  }
}
