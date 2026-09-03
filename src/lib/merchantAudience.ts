import { sql, type QueryExecutor } from './db';
import { getVenues } from './venues';

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Coarse totals still used by merchant reports. */
export interface MerchantAudienceSnapshot {
  currentSavers: number;
  currentFollowers: number;
  currentAlertSubscribers: number;
}

export interface MerchantAudienceChannelSplit {
  email: number;
  text: number;
}

export interface MerchantAudienceSourceSplit {
  venueFollow: number;
  listSubscription: number;
}

export interface MerchantAudienceAlertBreakdown {
  /** Distinct users with this alert type on (sources may overlap). */
  total: number;
  byChannel: MerchantAudienceChannelSplit;
  bySource: MerchantAudienceSourceSplit;
}

export interface MerchantAudienceDetail {
  generatedAt: string;
  venue: { id: number; name: string; neighborhood: string };
  /** Per-type counts can overlap the same user across HH / live / events. */
  overlapNote: string;
  happyHourAlerts: MerchantAudienceAlertBreakdown;
  liveDeals: MerchantAudienceAlertBreakdown;
  events: {
    total: number;
    comingSoon: true;
    note: string;
  };
  saves: { total: number };
  followers: { total: number };
}

/**
 * Point-in-time follower / alert preference counts for a venue.
 * Channel and source buckets can overlap; `total` is distinct users per type.
 */
export async function getMerchantAudienceDetail(
  venueId: number,
  executor: QueryExecutor = sql
): Promise<MerchantAudienceDetail> {
  const venue = getVenues().find((item) => item.id === venueId);
  if (!venue) throw new RangeError('Venue not found.');

  const rows = await executor<any>`
    WITH venue_hh AS (
      SELECT user_id, channel_email, channel_text
      FROM venue_follows
      WHERE venue_id = ${venueId} AND happy_hour_alerts_enabled
    ),
    list_hh AS (
      SELECT s.user_id,
        bool_or(s.channel_email) AS channel_email,
        bool_or(s.channel_text) AS channel_text
      FROM happy_hour_list_subscriptions s
      JOIN happy_hour_list_items i ON i.list_id = s.list_id
      WHERE i.venue_id = ${venueId} AND s.happy_hour_alerts_enabled
      GROUP BY s.user_id
    ),
    hh_users AS (
      SELECT user_id,
        bool_or(channel_email) AS channel_email,
        bool_or(channel_text) AS channel_text,
        bool_or(source = 'venue') AS from_venue,
        bool_or(source = 'list') AS from_list
      FROM (
        SELECT user_id, channel_email, channel_text, 'venue'::text AS source FROM venue_hh
        UNION ALL
        SELECT user_id, channel_email, channel_text, 'list'::text AS source FROM list_hh
      ) hh_sources
      GROUP BY user_id
    ),
    venue_live AS (
      SELECT user_id, channel_email, channel_text
      FROM venue_follows
      WHERE venue_id = ${venueId} AND promotion_alerts_enabled
    ),
    list_live AS (
      SELECT s.user_id,
        bool_or(s.channel_email) AS channel_email,
        bool_or(s.channel_text) AS channel_text
      FROM happy_hour_list_subscriptions s
      JOIN happy_hour_list_items i ON i.list_id = s.list_id
      WHERE i.venue_id = ${venueId} AND s.live_deal_alerts_enabled
      GROUP BY s.user_id
    ),
    live_users AS (
      SELECT user_id,
        bool_or(channel_email) AS channel_email,
        bool_or(channel_text) AS channel_text,
        bool_or(source = 'venue') AS from_venue,
        bool_or(source = 'list') AS from_list
      FROM (
        SELECT user_id, channel_email, channel_text, 'venue'::text AS source FROM venue_live
        UNION ALL
        SELECT user_id, channel_email, channel_text, 'list'::text AS source FROM list_live
      ) live_sources
      GROUP BY user_id
    )
    SELECT
      (SELECT count(*) FROM hh_users) AS hh_total,
      (SELECT count(*) FROM hh_users WHERE channel_email) AS hh_email,
      (SELECT count(*) FROM hh_users WHERE channel_text) AS hh_text,
      (SELECT count(*) FROM hh_users WHERE from_venue) AS hh_venue,
      (SELECT count(*) FROM hh_users WHERE from_list) AS hh_list,
      (SELECT count(*) FROM live_users) AS live_total,
      (SELECT count(*) FROM live_users WHERE channel_email) AS live_email,
      (SELECT count(*) FROM live_users WHERE channel_text) AS live_text,
      (SELECT count(*) FROM live_users WHERE from_venue) AS live_venue,
      (SELECT count(*) FROM live_users WHERE from_list) AS live_list,
      (SELECT count(*) FROM venue_follows
       WHERE venue_id = ${venueId} AND event_alerts_enabled) AS events_total,
      (SELECT count(DISTINCT l.owner_user_id)
       FROM happy_hour_list_items i
       JOIN happy_hour_lists l ON l.id = i.list_id
       WHERE i.venue_id = ${venueId}) AS current_savers,
      (SELECT count(*) FROM venue_follows WHERE venue_id = ${venueId}) AS current_followers`;

  const row = rows[0] || {};
  return {
    generatedAt: new Date().toISOString(),
    venue: { id: venue.id, name: venue.name, neighborhood: venue.neighborhood },
    overlapNote: 'Per-type counts can overlap users; a person may appear in happy hour, live deals, and events.',
    happyHourAlerts: {
      total: numberValue(row.hh_total),
      byChannel: {
        email: numberValue(row.hh_email),
        text: numberValue(row.hh_text),
      },
      bySource: {
        venueFollow: numberValue(row.hh_venue),
        listSubscription: numberValue(row.hh_list),
      },
    },
    liveDeals: {
      total: numberValue(row.live_total),
      byChannel: {
        email: numberValue(row.live_email),
        text: numberValue(row.live_text),
      },
      bySource: {
        venueFollow: numberValue(row.live_venue),
        listSubscription: numberValue(row.live_list),
      },
    },
    events: {
      total: numberValue(row.events_total),
      comingSoon: true,
      note: 'Events coming soon',
    },
    saves: { total: numberValue(row.current_savers) },
    followers: { total: numberValue(row.current_followers) },
  };
}

/**
 * Coarse snapshot for reports: savers, followers, and blended alert subscribers
 * (HH or live on venue follow, or any list subscription covering the venue).
 */
export async function getMerchantAudienceSnapshot(
  venueId: number,
  executor: QueryExecutor = sql
): Promise<MerchantAudienceSnapshot> {
  const rows = await executor<any>`
    SELECT
      (SELECT count(DISTINCT l.owner_user_id)
       FROM happy_hour_list_items i JOIN happy_hour_lists l ON l.id = i.list_id
       WHERE i.venue_id = ${venueId}) AS current_savers,
      (SELECT count(*) FROM venue_follows WHERE venue_id = ${venueId}) AS current_followers,
      (SELECT count(DISTINCT subscriber_id) FROM (
        SELECT user_id AS subscriber_id FROM venue_follows
        WHERE venue_id = ${venueId} AND (happy_hour_alerts_enabled OR promotion_alerts_enabled)
        UNION
        SELECT s.user_id AS subscriber_id
        FROM happy_hour_list_subscriptions s
        JOIN happy_hour_list_items i ON i.list_id = s.list_id
        WHERE i.venue_id = ${venueId}
      ) subscribers) AS current_alert_subscribers`;
  return {
    currentSavers: numberValue(rows[0]?.current_savers),
    currentFollowers: numberValue(rows[0]?.current_followers),
    currentAlertSubscribers: numberValue(rows[0]?.current_alert_subscribers),
  };
}
