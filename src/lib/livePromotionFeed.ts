import {
  isPublicLivePromotion,
  isPublicPromotionLiveAt,
  redactPromotionDealCodes,
  type LivePromotionsResponse,
  type PublicLivePromotion,
} from './consumerPromotionState';
import {
  createServerAnchoredClock,
  type ServerAnchoredClock,
} from './promotionClientTime';
import { parseInstant } from './sanDiegoTime';

export const DEFAULT_LIVE_PROMOTION_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_LIVE_PROMOTION_FAILURE_INTERVAL_MS = 5 * 60_000;

export interface LivePromotionFeedData {
  serverNow: string;
  clock: ServerAnchoredClock;
  promotions: readonly PublicLivePromotion[];
}

export interface LivePromotionFeedSnapshot {
  data: LivePromotionFeedData | null;
  refreshing: boolean;
  error: Error | null;
}

export interface LivePromotionFeedRuntime {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  monotonicNow(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  isVisible(): boolean;
  isOnline(): boolean;
  onVisibilityChange(callback: () => void): () => void;
  onPageShow(callback: () => void): () => void;
  onOnline(callback: () => void): () => void;
}

export interface LivePromotionFeed {
  getSnapshot(): LivePromotionFeedSnapshot;
  subscribe(listener: (snapshot: LivePromotionFeedSnapshot) => void): () => void;
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  /** Redacts cached secrets synchronously, invalidates old requests, then refetches. */
  authenticationChanged(): Promise<void>;
}

export interface LivePromotionFeedOptions {
  venueId?: number;
  pollIntervalMs?: number;
  failureIntervalMs?: number;
  runtime?: LivePromotionFeedRuntime;
}

export class LivePromotionFeedError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'LivePromotionFeedError';
    this.status = status;
  }
}

function browserEventSubscription(
  target: EventTarget | undefined,
  eventName: string,
  callback: () => void
): () => void {
  if (!target) return () => {};
  target.addEventListener(eventName, callback);
  return () => target.removeEventListener(eventName, callback);
}

function createBrowserRuntime(): LivePromotionFeedRuntime {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    monotonicNow: () => {
      if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
        throw new LivePromotionFeedError('A monotonic browser clock is unavailable.');
      }
      return performance.now();
    },
    setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    isVisible: () =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden',
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    onVisibilityChange: (callback) =>
      browserEventSubscription(
        typeof document === 'undefined' ? undefined : document,
        'visibilitychange',
        callback
      ),
    onPageShow: (callback) =>
      browserEventSubscription(
        typeof window === 'undefined' ? undefined : window,
        'pageshow',
        callback
      ),
    onOnline: (callback) =>
      browserEventSubscription(
        typeof window === 'undefined' ? undefined : window,
        'online',
        callback
      ),
  };
}

function positiveInterval(value: number | undefined, fallback: number): number {
  const interval = value ?? fallback;
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new RangeError('Feed intervals must be finite positive numbers.');
  }
  return interval;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function validatePayload(value: unknown): LivePromotionsResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { serverNow?: unknown }).serverNow !== 'string' ||
    !Array.isArray((value as { promotions?: unknown }).promotions)
  ) {
    throw new LivePromotionFeedError('The Live Promotions response was malformed.');
  }

  const payload = value as { serverNow: string; promotions: unknown[] };
  if (!payload.promotions.every(isPublicLivePromotion)) {
    throw new LivePromotionFeedError('The Live Promotions response contained an invalid promotion.');
  }
  return payload as LivePromotionsResponse;
}

export function createLivePromotionFeed(
  options: LivePromotionFeedOptions = {}
): LivePromotionFeed {
  const venueId = options.venueId;
  if (venueId !== undefined && (!Number.isSafeInteger(venueId) || venueId <= 0)) {
    throw new RangeError('venueId must be a positive safe integer.');
  }

  const runtime = options.runtime ?? createBrowserRuntime();
  const pollIntervalMs = positiveInterval(
    options.pollIntervalMs,
    DEFAULT_LIVE_PROMOTION_POLL_INTERVAL_MS
  );
  const failureIntervalMs = positiveInterval(
    options.failureIntervalMs,
    DEFAULT_LIVE_PROMOTION_FAILURE_INTERVAL_MS
  );
  const endpoint = venueId === undefined
    ? '/api/promotions/live'
    : `/api/promotions/live?venueId=${venueId}`;
  const listeners = new Set<(snapshot: LivePromotionFeedSnapshot) => void>();
  let snapshot: LivePromotionFeedSnapshot = { data: null, refreshing: false, error: null };
  let running = false;
  let requestGeneration = 0;
  let timer: unknown;
  let abortController: AbortController | null = null;
  let inFlight: Promise<void> | null = null;
  let refreshWhenSettled = false;
  let removeRuntimeListeners: Array<() => void> = [];

  const isActive = () => running && runtime.isVisible() && runtime.isOnline();

  const emit = () => {
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('Live Promotion feed subscriber failed.', error);
      }
    }
  };

  const replaceSnapshot = (next: LivePromotionFeedSnapshot) => {
    snapshot = next;
    emit();
  };

  const clearScheduledRefresh = () => {
    if (timer === undefined) return;
    runtime.clearTimer(timer);
    timer = undefined;
  };

  const pruneExpiredPromotions = (): boolean => {
    if (!snapshot.data) return false;
    const now = snapshot.data.clock.now();
    const promotions = snapshot.data.promotions.filter((promotion) =>
      isPublicPromotionLiveAt(promotion, now)
    );
    if (promotions.length === snapshot.data.promotions.length) return false;
    snapshot = {
      ...snapshot,
      data: { ...snapshot.data, promotions },
    };
    return true;
  };

  const nextExpiryDelay = (): number | null => {
    if (!snapshot.data?.promotions.length) return null;
    const now = snapshot.data.clock.now().getTime();
    return Math.max(
      0,
      Math.min(
        ...snapshot.data.promotions.map(
          (promotion) => (parseInstant(promotion.effectiveEndsAt)?.getTime() ?? now) - now
        )
      )
    );
  };

  const scheduleRefresh = (maximumDelay: number) => {
    clearScheduledRefresh();
    if (!isActive()) return;
    const expiryDelay = nextExpiryDelay();
    const delay = expiryDelay === null ? maximumDelay : Math.min(maximumDelay, expiryDelay);
    timer = runtime.setTimer(() => {
      timer = undefined;
      const changed = pruneExpiredPromotions();
      if (changed) emit();
      void refresh();
    }, Math.max(0, delay));
  };

  const invalidateActiveRequest = () => {
    requestGeneration += 1;
    abortController?.abort();
    abortController = null;
  };

  const pause = () => {
    clearScheduledRefresh();
    if (inFlight) refreshWhenSettled = true;
    invalidateActiveRequest();
    if (snapshot.refreshing) replaceSnapshot({ ...snapshot, refreshing: false });
  };

  const refresh = (): Promise<void> => {
    if (!isActive()) return Promise.resolve();
    if (inFlight) return inFlight;

    const generation = requestGeneration;
    const requestStartedAt = runtime.monotonicNow();
    const controller = new AbortController();
    abortController = controller;
    replaceSnapshot({ ...snapshot, refreshing: true });

    let operation: Promise<void>;
    operation = (async () => {
      try {
        const response = await runtime.fetch(endpoint, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new LivePromotionFeedError(
            `Live Promotions request failed with status ${response.status}.`,
            response.status
          );
        }
        const rawPayload = await response.json();
        const responseReceivedAt = runtime.monotonicNow();
        const payload = validatePayload(rawPayload);
        const clock = createServerAnchoredClock({
          serverNow: payload.serverNow,
          monotonicNow: () => runtime.monotonicNow(),
          requestStartedAt,
          responseReceivedAt,
        });
        if (venueId !== undefined && payload.promotions.some((item) => item.venueId !== venueId)) {
          throw new LivePromotionFeedError('A venue-scoped response contained another venue.');
        }
        if (generation !== requestGeneration || !running) return;

        const now = clock.now();
        const promotions = payload.promotions.filter((promotion) =>
          isPublicPromotionLiveAt(promotion, now)
        );
        replaceSnapshot({
          data: { serverNow: payload.serverNow, clock, promotions },
          refreshing: false,
          error: null,
        });
        scheduleRefresh(pollIntervalMs);
      } catch (error) {
        if (generation !== requestGeneration || controller.signal.aborted || !running) return;
        pruneExpiredPromotions();
        replaceSnapshot({ ...snapshot, refreshing: false, error: asError(error) });
        scheduleRefresh(failureIntervalMs);
      }
    })().finally(() => {
      if (inFlight === operation) inFlight = null;
      if (abortController === controller) abortController = null;
      if (refreshWhenSettled && isActive()) {
        refreshWhenSettled = false;
        void refresh();
      }
    });
    inFlight = operation;
    return operation;
  };

  const resume = () => {
    if (!isActive()) {
      pause();
      return;
    }
    if (!inFlight) {
      refreshWhenSettled = false;
      void refresh();
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (running) return;
      running = true;
      // A request aborted by stop() may still be settling. Its generation is
      // stale, so reconcile as soon as it releases the coalescing slot.
      if (inFlight) refreshWhenSettled = true;
      removeRuntimeListeners = [
        runtime.onVisibilityChange(resume),
        runtime.onPageShow(resume),
        runtime.onOnline(resume),
      ];
      resume();
    },
    stop() {
      if (!running) return;
      running = false;
      refreshWhenSettled = false;
      clearScheduledRefresh();
      invalidateActiveRequest();
      for (const removeListener of removeRuntimeListeners) removeListener();
      removeRuntimeListeners = [];
      if (snapshot.refreshing) replaceSnapshot({ ...snapshot, refreshing: false });
    },
    refresh,
    async authenticationChanged() {
      if (snapshot.data) {
        replaceSnapshot({
          ...snapshot,
          data: {
            ...snapshot.data,
            promotions: redactPromotionDealCodes(snapshot.data.promotions),
          },
        });
      }
      invalidateActiveRequest();
      const pending = inFlight;
      if (pending) await pending;
      if (isActive()) await refresh();
    },
  };
}
