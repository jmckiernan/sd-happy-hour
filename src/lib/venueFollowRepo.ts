import { sql, type QueryExecutor } from './db';

export interface VenueFollow {
  userId: string;
  venueId: number;
  happyHourAlertsEnabled: boolean;
  promotionAlertsEnabled: boolean;
  channels: {
    email: boolean;
    text: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

interface VenueFollowRow {
  user_id: string;
  venue_id: number;
  happy_hour_alerts_enabled: boolean;
  promotion_alerts_enabled: boolean;
  channel_email: boolean;
  channel_text: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ReplaceVenueFollowInput {
  happyHourAlertsEnabled: boolean;
  promotionAlertsEnabled: boolean;
  channelEmail: boolean;
  channelText: boolean;
}

function iso(value: Date | string): string {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new RangeError('Expected a valid follow timestamp.');
  return instant.toISOString();
}

function mapVenueFollow(row: VenueFollowRow): VenueFollow {
  return {
    userId: row.user_id,
    venueId: row.venue_id,
    happyHourAlertsEnabled: row.happy_hour_alerts_enabled,
    promotionAlertsEnabled: row.promotion_alerts_enabled,
    channels: { email: row.channel_email, text: row.channel_text },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function listVenueFollows(
  userId: string,
  executor: QueryExecutor = sql
): Promise<VenueFollow[]> {
  const rows = await executor<VenueFollowRow>`
    SELECT * FROM venue_follows
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, venue_id ASC`;
  return rows.map(mapVenueFollow);
}

export async function getVenueFollowForUpdate(
  userId: string,
  venueId: number,
  executor: QueryExecutor
): Promise<VenueFollow | null> {
  const rows = await executor<VenueFollowRow>`
    SELECT * FROM venue_follows
    WHERE user_id = ${userId} AND venue_id = ${venueId}
    FOR UPDATE`;
  return rows[0] ? mapVenueFollow(rows[0]) : null;
}

export async function replaceVenueFollow(
  userId: string,
  venueId: number,
  input: ReplaceVenueFollowInput,
  executor: QueryExecutor
): Promise<VenueFollow> {
  const rows = await executor<VenueFollowRow>`
    INSERT INTO venue_follows (
      user_id, venue_id, happy_hour_alerts_enabled,
      promotion_alerts_enabled, channel_email, channel_text
    ) VALUES (
      ${userId}, ${venueId}, ${input.happyHourAlertsEnabled},
      ${input.promotionAlertsEnabled}, ${input.channelEmail}, ${input.channelText}
    )
    ON CONFLICT (user_id, venue_id) DO UPDATE SET
      happy_hour_alerts_enabled = EXCLUDED.happy_hour_alerts_enabled,
      promotion_alerts_enabled = EXCLUDED.promotion_alerts_enabled,
      channel_email = EXCLUDED.channel_email,
      channel_text = EXCLUDED.channel_text
    RETURNING *`;
  return mapVenueFollow(rows[0]);
}

export async function deleteVenueFollow(
  userId: string,
  venueId: number,
  executor: QueryExecutor = sql
): Promise<boolean> {
  const rows = await executor<{ venue_id: number }>`
    DELETE FROM venue_follows
    WHERE user_id = ${userId} AND venue_id = ${venueId}
    RETURNING venue_id`;
  return Boolean(rows[0]);
}
