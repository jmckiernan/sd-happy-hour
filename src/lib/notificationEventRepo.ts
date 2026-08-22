import type { QueryExecutor } from './db';
import { getPromotionEventKey } from './notificationEvents';
import type { PromotionCampaign } from './promotionRepo';

export interface NotificationEventRecord {
  id: string;
  eventKey: string;
  eventType: 'promotion_started';
  venueId: number;
  promotionId: string;
  availableAt: string;
  expiresAt: string;
  cancelledAt: string | null;
}

interface NotificationEventRow {
  id: string;
  event_key: string;
  event_type: 'promotion_started';
  venue_id: number;
  promotion_id: string;
  available_at: Date | string;
  expires_at: Date | string;
  cancelled_at: Date | string | null;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function mapEvent(row: NotificationEventRow): NotificationEventRecord {
  return {
    id: row.id,
    eventKey: row.event_key,
    eventType: row.event_type,
    venueId: row.venue_id,
    promotionId: row.promotion_id,
    availableAt: iso(row.available_at)!,
    expiresAt: iso(row.expires_at)!,
    cancelledAt: iso(row.cancelled_at),
  };
}

function completeWindow(promotion: PromotionCampaign): { startsAt: string; endsAt: string } {
  if (!promotion.startsAt || !promotion.endsAt) {
    throw new RangeError('A promotion event requires a complete promotion window.');
  }
  return { startsAt: promotion.startsAt, endsAt: promotion.endsAt };
}

export async function upsertPromotionStartedEvent(
  executor: QueryExecutor,
  promotion: PromotionCampaign
): Promise<NotificationEventRecord> {
  const { startsAt, endsAt } = completeWindow(promotion);
  const eventKey = getPromotionEventKey(promotion);
  const rows = await executor<NotificationEventRow>`
    INSERT INTO notification_events (
      event_key, event_type, venue_id, promotion_id, available_at, expires_at,
      cancelled_at
    ) VALUES (
      ${eventKey}, 'promotion_started', ${promotion.venueId}, ${promotion.id},
      ${startsAt}, ${endsAt}, NULL
    )
    ON CONFLICT (event_key) DO UPDATE SET
      venue_id = EXCLUDED.venue_id,
      promotion_id = EXCLUDED.promotion_id,
      available_at = EXCLUDED.available_at,
      expires_at = EXCLUDED.expires_at,
      cancelled_at = NULL
    RETURNING id, event_key, event_type, venue_id, promotion_id,
              available_at, expires_at, cancelled_at`;
  return mapEvent(rows[0]);
}

export async function cancelPromotionStartedEvent(
  executor: QueryExecutor,
  promotionId: string,
  cancelledAt: string
): Promise<NotificationEventRecord | null> {
  const rows = await executor<NotificationEventRow>`
    UPDATE notification_events
    SET cancelled_at = ${cancelledAt}
    WHERE promotion_id = ${promotionId} AND event_type = 'promotion_started'
    RETURNING id, event_key, event_type, venue_id, promotion_id,
              available_at, expires_at, cancelled_at`;
  return rows[0] ? mapEvent(rows[0]) : null;
}

/**
 * A normal early end shortens event eligibility without calling a legitimate
 * started event "cancelled". If it ends at the exact available instant, the
 * schema cannot store an empty window; mark that zero-deliverable event
 * cancelled and retain its original valid bounds.
 */
export async function expirePromotionStartedEvent(
  executor: QueryExecutor,
  promotionId: string,
  endedAt: string
): Promise<NotificationEventRecord | null> {
  const rows = await executor<NotificationEventRow>`
    UPDATE notification_events
    SET
      expires_at = CASE
        WHEN available_at < ${endedAt} THEN LEAST(expires_at, ${endedAt})
        ELSE expires_at
      END,
      cancelled_at = CASE
        WHEN available_at < ${endedAt} THEN cancelled_at
        ELSE ${endedAt}
      END
    WHERE promotion_id = ${promotionId} AND event_type = 'promotion_started'
    RETURNING id, event_key, event_type, venue_id, promotion_id,
              available_at, expires_at, cancelled_at`;
  return rows[0] ? mapEvent(rows[0]) : null;
}

export async function getPromotionStartedEvent(
  executor: QueryExecutor,
  promotionId: string
): Promise<NotificationEventRecord | null> {
  const rows = await executor<NotificationEventRow>`
    SELECT id, event_key, event_type, venue_id, promotion_id,
           available_at, expires_at, cancelled_at
    FROM notification_events
    WHERE promotion_id = ${promotionId} AND event_type = 'promotion_started'`;
  return rows[0] ? mapEvent(rows[0]) : null;
}
