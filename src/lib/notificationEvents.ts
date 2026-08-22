import { getSanDiegoParts, parseInstant, type HappyHourOccurrence, type InstantInput } from './sanDiegoTime';

export const NOTIFICATION_EVENT_TYPES = ['happy_hour_started', 'promotion_started'] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export const NOTIFICATION_DISTRIBUTION_SOURCES = ['organic_follow', 'saved_alert', 'paid_boost'] as const;
export type NotificationDistributionSource = (typeof NOTIFICATION_DISTRIBUTION_SOURCES)[number];

export type NotificationChannel = 'email' | 'text';

export interface HappyHourEventIdentity {
  venueId: number;
  startsAt?: InstantInput;
  dateKey?: string;
  startTime?: string;
}

function pacificOccurrenceKey(value: InstantInput): { dateKey: string; startTime: string } {
  const instant = parseInstant(value);
  if (!instant) throw new RangeError('Notification event time must be an absolute instant.');
  const parts = getSanDiegoParts(instant);
  const pad = (part: number) => String(part).padStart(2, '0');
  return {
    dateKey: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    startTime: `${pad(parts.hour)}:${pad(parts.minute)}`,
  };
}

/**
 * Identity for one recurring happy-hour occurrence. User and channel belong
 * to the delivery/dedup row alongside this event key, not inside the event.
 */
export function getHappyHourEventKey(identity: HappyHourEventIdentity | HappyHourOccurrence): string;
export function getHappyHourEventKey(venueId: number, startsAt: InstantInput): string;
export function getHappyHourEventKey(
  identityOrVenueId: HappyHourEventIdentity | HappyHourOccurrence | number,
  occurrenceStart?: InstantInput
): string {
  const venueId = typeof identityOrVenueId === 'number'
    ? identityOrVenueId
    : identityOrVenueId.venueId;
  const startsAt = typeof identityOrVenueId === 'number'
    ? occurrenceStart
    : identityOrVenueId.startsAt;
  let dateKey = typeof identityOrVenueId === 'number' ? '' : identityOrVenueId.dateKey || '';
  let startTime = typeof identityOrVenueId === 'number' ? '' : identityOrVenueId.startTime || '';
  if ((!dateKey || !startTime) && startsAt != null) {
    ({ dateKey, startTime } = pacificOccurrenceKey(startsAt));
  }
  if (
    !Number.isInteger(venueId) ||
    venueId <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dateKey) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)
  ) {
    throw new RangeError('Happy-hour event identity requires a positive venue id, Pacific date, and start time.');
  }
  return `hh:${venueId}:${dateKey}:${startTime}`;
}

export function getPromotionEventKey(promotion: string | { id: string }): string {
  const promotionId = String(typeof promotion === 'string' ? promotion : promotion?.id || '').trim();
  if (!promotionId) throw new RangeError('Promotion event identity requires a promotion id.');
  return `promotion:${promotionId}`;
}
