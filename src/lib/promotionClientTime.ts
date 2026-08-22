import {
  SD_TIME_ZONE,
  getSanDiegoParts,
  parseInstant,
  parseSanDiegoLocalDateTime,
  type InstantInput,
} from './sanDiegoTime';

export interface ServerAnchoredClock {
  /** A fresh Date derived from the server anchor and monotonic elapsed time. */
  now(): Date;
}

export interface ServerClockAnchor {
  serverNow: InstantInput;
  monotonicNow?: () => number;
  /** Monotonic request timing samples allow the anchor to include half the RTT. */
  requestStartedAt?: number;
  responseReceivedAt?: number;
}

export type SanDiegoLocalDateTimeResult =
  | { status: 'resolved'; instant: Date }
  | { status: 'ambiguous'; earlier: Date; later: Date }
  | { status: 'nonexistent' }
  | { status: 'invalid' };

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const sanDiegoTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SD_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

const sanDiegoDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SD_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

function defaultMonotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  throw new RangeError('A monotonic clock is required for server-anchored time.');
}

function requireInstant(value: InstantInput): Date {
  const instant = parseInstant(value);
  if (!instant) throw new RangeError('Expected a valid absolute instant.');
  return instant;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function hasRealCalendarDate(year: number, month: number, day: number): boolean {
  const instant = new Date(Date.UTC(year, month - 1, day));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  );
}

/**
 * Anchor client presentation time to an API-provided instant. Device wall-clock
 * changes cannot move this clock; only monotonic elapsed time advances it.
 */
export function createServerAnchoredClock(anchor: ServerClockAnchor): ServerAnchoredClock {
  const serverNow = requireInstant(anchor.serverNow);
  const monotonicNow = anchor.monotonicNow ?? defaultMonotonicNow;
  const hasRequestSample = anchor.requestStartedAt !== undefined;
  const hasResponseSample = anchor.responseReceivedAt !== undefined;

  if (hasRequestSample !== hasResponseSample) {
    throw new RangeError('Request and response timing samples must be supplied together.');
  }

  let referenceMonotonic: number;
  let estimatedReceiptTime = serverNow.getTime();
  if (hasRequestSample && hasResponseSample) {
    const requestStartedAt = anchor.requestStartedAt as number;
    const responseReceivedAt = anchor.responseReceivedAt as number;
    if (
      !Number.isFinite(requestStartedAt) ||
      !Number.isFinite(responseReceivedAt) ||
      responseReceivedAt < requestStartedAt
    ) {
      throw new RangeError('Expected ordered, finite request timing samples.');
    }
    estimatedReceiptTime += (responseReceivedAt - requestStartedAt) / 2;
    referenceMonotonic = responseReceivedAt;
  } else {
    referenceMonotonic = monotonicNow();
    if (!Number.isFinite(referenceMonotonic)) {
      throw new RangeError('Expected a finite monotonic clock sample.');
    }
  }

  let lastMonotonic = referenceMonotonic;
  let lastInstant = estimatedReceiptTime;

  return {
    now(): Date {
      const sample = monotonicNow();
      if (!Number.isFinite(sample)) {
        throw new RangeError('Expected a finite monotonic clock sample.');
      }
      if (sample > lastMonotonic) {
        lastInstant += sample - lastMonotonic;
        lastMonotonic = sample;
      }
      return new Date(lastInstant);
    },
  };
}

/** Resolve an HTML datetime-local value using the Phase 1 San Diego rules. */
export function resolveSanDiegoDateTimeLocal(value: string): SanDiegoLocalDateTimeResult {
  const normalized = String(value ?? '').trim();
  const match = LOCAL_DATE_TIME.exec(normalized);
  if (!match) return { status: 'invalid' };

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');
  if (
    !hasRealCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { status: 'invalid' };
  }

  const earlier = parseSanDiegoLocalDateTime(normalized, { disambiguation: 'earlier' });
  const later = parseSanDiegoLocalDateTime(normalized, { disambiguation: 'later' });
  if (!earlier || !later) return { status: 'nonexistent' };
  if (earlier.getTime() !== later.getTime()) {
    return { status: 'ambiguous', earlier, later };
  }
  return { status: 'resolved', instant: earlier };
}

export function formatSanDiegoDateTimeInput(value: InstantInput): string {
  const parts = getSanDiegoParts(requireInstant(value));
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatSanDiegoTime(value: InstantInput): string {
  return sanDiegoTimeFormatter.format(requireInstant(value));
}

export function formatSanDiegoDateTime(value: InstantInput): string {
  return sanDiegoDateTimeFormatter.format(requireInstant(value));
}

/** Compact duration text for a future boundary. Returns null at or after it. */
export function formatCountdown(target: InstantInput, now: InstantInput): string | null {
  const remainingMilliseconds = requireInstant(target).getTime() - requireInstant(now).getTime();
  if (remainingMilliseconds <= 0) return null;

  const remainingMinutes = Math.ceil(remainingMilliseconds / 60_000);
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}
