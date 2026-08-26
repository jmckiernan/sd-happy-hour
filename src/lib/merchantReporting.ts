import { sql, type QueryExecutor } from './db';
import { getPromotionState, type PromotionState } from './promotionState';
import { parseSanDiegoLocalDateTime } from './sanDiegoTime';
import { getVenues } from './venues';

export type MerchantReportPreset = '7d' | '30d' | '90d' | 'custom';

export interface MerchantReportRange {
  preset: MerchantReportPreset;
  start: string;
  end: string;
  label: string;
  days: number;
}

const PRESET_DAYS: Record<Exclude<MerchantReportPreset, 'custom'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function resolveMerchantReportRange(input: {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  now?: Date;
}): MerchantReportRange {
  const now = input.now ?? new Date();
  const preset = input.preset === 'custom' ? 'custom' : (input.preset && input.preset in PRESET_DAYS ? input.preset : '30d') as MerchantReportPreset;
  if (preset !== 'custom') {
    const days = PRESET_DAYS[preset];
    return {
      preset,
      start: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
      end: now.toISOString(),
      label: `Last ${days} days`,
      days,
    };
  }
  const fromIsDate = /^\d{4}-\d{2}-\d{2}$/.test(input.from || '');
  const toIsDate = /^\d{4}-\d{2}-\d{2}$/.test(input.to || '');
  const from = fromIsDate
    ? parseSanDiegoLocalDateTime(`${input.from}T00:00`, { disambiguation: 'earlier' })
    : validDate(input.from);
  const requestedTo = toIsDate
    ? parseSanDiegoLocalDateTime(`${input.to}T00:00`, { disambiguation: 'earlier' })
    : validDate(input.to);
  if (!from || !requestedTo) throw new RangeError('Custom reports require valid from and to dates.');
  // Date inputs represent whole San Diego calendar dates. Resolve the next
  // local midnight explicitly so a DST transition never shifts the boundary.
  let to = requestedTo;
  let days: number;
  if (fromIsDate && toIsDate) {
    const [fromYear, fromMonth, fromDay] = input.from!.split('-').map(Number);
    const [toYear, toMonth, toDay] = input.to!.split('-').map(Number);
    const nextDay = new Date(Date.UTC(toYear, toMonth - 1, toDay + 1));
    const nextKey = `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDay.getUTCDate()).padStart(2, '0')}`;
    to = parseSanDiegoLocalDateTime(`${nextKey}T00:00`, { disambiguation: 'earlier' })!;
    days = Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / (24 * 60 * 60 * 1000)) + 1;
  } else {
    days = Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
  }
  if (days < 1 || days > 366 || to.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    throw new RangeError('Custom report ranges must span 1 to 366 days and cannot be in the future.');
  }
  return {
    preset: 'custom',
    start: from.toISOString(),
    end: to.toISOString(),
    label: `${from.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' })} - ${new Date(to.getTime() - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' })}`,
    days,
  };
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function merchantConversionRate(convertedVisits: number, uniqueVisits: number): number {
  if (!uniqueVisits) return 0;
  return Math.round((convertedVisits / uniqueVisits) * 10_000) / 100;
}

interface SummaryRow {
  total_views: string | number;
  authenticated_views: string | number;
  unauthenticated_views: string | number;
  unique_users: string | number;
  unique_visits: string | number;
  website_clicks: string | number;
  website_visits: string | number;
  call_clicks: string | number;
  call_visits: string | number;
  directions_clicks: string | number;
  directions_visits: string | number;
  saves: string | number;
  save_visits: string | number;
  shares: string | number;
  share_visits: string | number;
  follows: string | number;
  follow_visits: string | number;
  alert_subscriptions: string | number;
  promotion_views: string | number;
  promotion_view_visits: string | number;
  promotion_clicks: string | number;
  promotion_click_visits: string | number;
  campaigns_launched: string | number;
}

export interface MerchantReportSummary {
  totalViews: number;
  authenticatedViews: number;
  unauthenticatedViews: number;
  uniqueUsers: number;
  uniqueVisits: number;
  websiteClicks: number;
  callClicks: number;
  directionsClicks: number;
  saves: number;
  shares: number;
  follows: number;
  alertSubscriptions: number;
  promotionViews: number;
  promotionClicks: number;
  campaignsLaunched: number;
  websiteRate: number;
  callRate: number;
  directionsRate: number;
  saveRate: number;
  shareRate: number;
  followRate: number;
  campaignEngagementRate: number;
}

export function mapMerchantReportSummary(row: SummaryRow): MerchantReportSummary {
  const uniqueVisits = numberValue(row.unique_visits);
  const promotionViewVisits = numberValue(row.promotion_view_visits);
  return {
    totalViews: numberValue(row.total_views),
    authenticatedViews: numberValue(row.authenticated_views),
    unauthenticatedViews: numberValue(row.unauthenticated_views),
    uniqueUsers: numberValue(row.unique_users),
    uniqueVisits,
    websiteClicks: numberValue(row.website_clicks),
    callClicks: numberValue(row.call_clicks),
    directionsClicks: numberValue(row.directions_clicks),
    saves: numberValue(row.saves),
    shares: numberValue(row.shares),
    follows: numberValue(row.follows),
    alertSubscriptions: numberValue(row.alert_subscriptions),
    promotionViews: numberValue(row.promotion_views),
    promotionClicks: numberValue(row.promotion_clicks),
    campaignsLaunched: numberValue(row.campaigns_launched),
    websiteRate: merchantConversionRate(numberValue(row.website_visits), uniqueVisits),
    callRate: merchantConversionRate(numberValue(row.call_visits), uniqueVisits),
    directionsRate: merchantConversionRate(numberValue(row.directions_visits), uniqueVisits),
    saveRate: merchantConversionRate(numberValue(row.save_visits), uniqueVisits),
    shareRate: merchantConversionRate(numberValue(row.share_visits), uniqueVisits),
    followRate: merchantConversionRate(numberValue(row.follow_visits), uniqueVisits),
    campaignEngagementRate: merchantConversionRate(numberValue(row.promotion_click_visits), promotionViewVisits),
  };
}

async function reportSummary(
  venueId: number,
  ownerUserId: string,
  range: MerchantReportRange,
  executor: QueryExecutor
): Promise<MerchantReportSummary> {
  const rows = await executor<SummaryRow>`
    WITH events AS (
      SELECT * FROM merchant_analytics_events
      WHERE venue_id = ${venueId} AND venue_owner_user_id = ${ownerUserId}
        AND occurred_at >= ${range.start} AND occurred_at < ${range.end}
    ), viewed_visits AS (
      SELECT DISTINCT visit_id FROM events
      WHERE event_name = 'venue_page_view' AND visit_id IS NOT NULL
    )
    SELECT
      count(*) FILTER (WHERE event_name = 'venue_page_view') AS total_views,
      count(*) FILTER (WHERE event_name = 'venue_page_view' AND authenticated) AS authenticated_views,
      count(*) FILTER (WHERE event_name = 'venue_page_view' AND NOT authenticated) AS unauthenticated_views,
      count(DISTINCT CASE WHEN event_name = 'venue_page_view'
        THEN COALESCE('u:' || user_id::text, 'v:' || visitor_id::text) END) AS unique_users,
      count(DISTINCT visit_id) FILTER (WHERE event_name = 'venue_page_view') AS unique_visits,
      count(*) FILTER (WHERE event_name = 'website_click') AS website_clicks,
      count(DISTINCT visit_id) FILTER (WHERE event_name = 'website_click' AND visit_id IN (SELECT visit_id FROM viewed_visits)) AS website_visits,
      count(*) FILTER (WHERE event_name = 'call_click') AS call_clicks,
      count(DISTINCT visit_id) FILTER (WHERE event_name = 'call_click' AND visit_id IN (SELECT visit_id FROM viewed_visits)) AS call_visits,
      count(*) FILTER (WHERE event_name = 'directions_click') AS directions_clicks,
      count(DISTINCT visit_id) FILTER (WHERE event_name = 'directions_click' AND visit_id IN (SELECT visit_id FROM viewed_visits)) AS directions_visits,
      count(*) FILTER (WHERE event_name = 'save') AS saves,
      count(DISTINCT visit_id) FILTER (WHERE event_name = 'save' AND visit_id IN (SELECT visit_id FROM viewed_visits)) AS save_visits,
      count(*) FILTER (WHERE event_name = 'share') AS shares,
      count(DISTINCT visit_id) FILTER (WHERE event_name = 'share' AND visit_id IN (SELECT visit_id FROM viewed_visits)) AS share_visits,
      count(*) FILTER (WHERE event_name = 'follow') AS follows,
      count(DISTINCT visit_id) FILTER (WHERE event_name = 'follow' AND visit_id IN (SELECT visit_id FROM viewed_visits)) AS follow_visits,
      count(*) FILTER (WHERE event_name = 'alert_subscribe') AS alert_subscriptions,
      count(*) FILTER (WHERE event_name = 'promotion_view') AS promotion_views,
      count(DISTINCT visit_id) FILTER (WHERE event_name = 'promotion_view') AS promotion_view_visits,
      count(*) FILTER (WHERE event_name = 'promotion_click') AS promotion_clicks,
      count(DISTINCT visit_id) FILTER (WHERE event_name = 'promotion_click') AS promotion_click_visits,
      count(DISTINCT promotion_id) FILTER (WHERE event_name = 'campaign_launch') AS campaigns_launched
    FROM events`;
  return mapMerchantReportSummary(rows[0] || {} as SummaryRow);
}

export interface MerchantReportTrendPoint {
  date: string;
  views: number;
  uniqueVisits: number;
  websiteClicks: number;
  callClicks: number;
  directionsClicks: number;
  promotionClicks: number;
}

async function reportTrend(
  venueId: number,
  ownerUserId: string,
  range: MerchantReportRange,
  executor: QueryExecutor
) {
  const rows = await executor<any>`
    WITH dates AS (
      SELECT generate_series(
        (${range.start}::timestamptz AT TIME ZONE 'America/Los_Angeles')::date,
        ((${range.end}::timestamptz - interval '1 millisecond') AT TIME ZONE 'America/Los_Angeles')::date,
        interval '1 day'
      )::date AS report_date
    ), daily AS (
      SELECT (occurred_at AT TIME ZONE 'America/Los_Angeles')::date AS report_date,
        count(*) FILTER (WHERE event_name = 'venue_page_view') AS views,
        count(DISTINCT visit_id) FILTER (WHERE event_name = 'venue_page_view') AS unique_visits,
        count(*) FILTER (WHERE event_name = 'website_click') AS website_clicks,
        count(*) FILTER (WHERE event_name = 'call_click') AS call_clicks,
        count(*) FILTER (WHERE event_name = 'directions_click') AS directions_clicks,
        count(*) FILTER (WHERE event_name = 'promotion_click') AS promotion_clicks
      FROM merchant_analytics_events
      WHERE venue_id = ${venueId} AND venue_owner_user_id = ${ownerUserId}
        AND occurred_at >= ${range.start} AND occurred_at < ${range.end}
      GROUP BY 1
    )
    SELECT dates.report_date, COALESCE(daily.views, 0) AS views,
      COALESCE(daily.unique_visits, 0) AS unique_visits,
      COALESCE(daily.website_clicks, 0) AS website_clicks,
      COALESCE(daily.call_clicks, 0) AS call_clicks,
      COALESCE(daily.directions_clicks, 0) AS directions_clicks,
      COALESCE(daily.promotion_clicks, 0) AS promotion_clicks
    FROM dates LEFT JOIN daily USING (report_date) ORDER BY dates.report_date`;
  return rows.map((row: any): MerchantReportTrendPoint => ({
    date: row.report_date instanceof Date ? row.report_date.toISOString().slice(0, 10) : String(row.report_date).slice(0, 10),
    views: numberValue(row.views),
    uniqueVisits: numberValue(row.unique_visits),
    websiteClicks: numberValue(row.website_clicks),
    callClicks: numberValue(row.call_clicks),
    directionsClicks: numberValue(row.directions_clicks),
    promotionClicks: numberValue(row.promotion_clicks),
  }));
}

export interface MerchantCampaignReport {
  id: string;
  title: string;
  type: string;
  state: PromotionState;
  startsAt: string | null;
  endsAt: string | null;
  views: number;
  clicks: number;
  uniqueViewVisits: number;
  uniqueClickVisits: number;
  engagementRate: number;
}

async function reportCampaigns(
  venueId: number,
  ownerUserId: string,
  range: MerchantReportRange,
  executor: QueryExecutor
) {
  const rows = await executor<any>`
    SELECT p.id, p.title, p.type, p.starts_at, p.ends_at, p.published_at, p.ended_at, p.cancelled_at,
      count(e.id) FILTER (WHERE e.event_name = 'promotion_view') AS views,
      count(e.id) FILTER (WHERE e.event_name = 'promotion_click') AS clicks,
      count(DISTINCT e.visit_id) FILTER (WHERE e.event_name = 'promotion_view') AS unique_view_visits,
      count(DISTINCT e.visit_id) FILTER (
        WHERE e.event_name = 'promotion_click' AND EXISTS (
          SELECT 1 FROM merchant_analytics_events viewed
          WHERE viewed.promotion_id = p.id AND viewed.visit_id = e.visit_id
            AND viewed.event_name = 'promotion_view'
            AND viewed.venue_owner_user_id = ${ownerUserId}
            AND viewed.occurred_at >= ${range.start} AND viewed.occurred_at < ${range.end}
        )
      ) AS unique_click_visits
    FROM promotion_campaigns p
    LEFT JOIN merchant_analytics_events e
      ON e.promotion_id = p.id AND e.venue_owner_user_id = ${ownerUserId}
        AND e.occurred_at >= ${range.start} AND e.occurred_at < ${range.end}
    WHERE p.venue_id = ${venueId}
      AND (p.created_at < ${range.end})
      AND (p.ends_at IS NULL OR p.ends_at >= ${range.start} OR e.id IS NOT NULL)
    GROUP BY p.id
    ORDER BY COALESCE(p.starts_at, p.created_at) DESC, p.id DESC`;
  return rows.map((row: any): MerchantCampaignReport => {
    const uniqueViewVisits = numberValue(row.unique_view_visits);
    const uniqueClickVisits = numberValue(row.unique_click_visits);
    const promotion = {
      startsAt: isoValue(row.starts_at), endsAt: isoValue(row.ends_at),
      publishedAt: isoValue(row.published_at), endedAt: isoValue(row.ended_at),
      cancelledAt: isoValue(row.cancelled_at),
    };
    return {
      id: row.id,
      title: row.title || 'Untitled campaign',
      type: row.type,
      state: getPromotionState(promotion),
      startsAt: promotion.startsAt,
      endsAt: promotion.endsAt,
      views: numberValue(row.views),
      clicks: numberValue(row.clicks),
      uniqueViewVisits,
      uniqueClickVisits,
      engagementRate: merchantConversionRate(uniqueClickVisits, uniqueViewVisits),
    };
  });
}

function isoValue(value: Date | string | null): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export interface MerchantAudienceSnapshot {
  currentSavers: number;
  currentFollowers: number;
  currentAlertSubscribers: number;
}

async function audienceSnapshot(venueId: number, executor: QueryExecutor): Promise<MerchantAudienceSnapshot> {
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

export interface MerchantVenueComparison {
  venueId: number;
  venueName: string;
  uniqueVisits: number;
  totalViews: number;
  actions: number;
  actionRate: number;
}

async function venueComparison(
  accessibleVenues: Array<{ venueId: number; ownerUserId: string }>,
  range: MerchantReportRange,
  executor: QueryExecutor
) {
  if (!accessibleVenues.length) return [];
  const venueIds = accessibleVenues.map((venue) => venue.venueId);
  const ownerUserIds = accessibleVenues.map((venue) => venue.ownerUserId);
  const rows = await executor<any>`
    WITH authorized AS (
      SELECT * FROM unnest(${venueIds}::integer[], ${ownerUserIds}::uuid[])
        AS access(venue_id, owner_user_id)
    ), events AS (
      SELECT e.* FROM merchant_analytics_events e
      JOIN authorized access
        ON access.venue_id = e.venue_id AND access.owner_user_id = e.venue_owner_user_id
      WHERE e.occurred_at >= ${range.start} AND e.occurred_at < ${range.end}
    ), viewed_visits AS (
      SELECT DISTINCT venue_id, visit_id FROM events
      WHERE event_name = 'venue_page_view' AND visit_id IS NOT NULL
    )
    SELECT venue_id,
      count(*) FILTER (WHERE event_name = 'venue_page_view') AS total_views,
      count(DISTINCT visit_id) FILTER (WHERE event_name = 'venue_page_view') AS unique_visits,
      count(DISTINCT visit_id) FILTER (WHERE event_name IN (
        'website_click', 'call_click', 'directions_click', 'save', 'share', 'follow', 'promotion_click'
      ) AND (venue_id, visit_id) IN (SELECT venue_id, visit_id FROM viewed_visits)) AS action_visits
    FROM events
    GROUP BY venue_id`;
  const rowByVenue = new Map(rows.map((row: any) => [Number(row.venue_id), row]));
  const nameByVenue = new Map(getVenues().map((venue) => [venue.id, venue.name]));
  return venueIds.map((venueId): MerchantVenueComparison => {
    const row: any = rowByVenue.get(venueId) || {};
    const uniqueVisits = numberValue(row.unique_visits);
    const actions = numberValue(row.action_visits);
    return {
      venueId,
      venueName: nameByVenue.get(venueId) || `Venue #${venueId}`,
      uniqueVisits,
      totalViews: numberValue(row.total_views),
      actions,
      actionRate: merchantConversionRate(actions, uniqueVisits),
    };
  });
}

export interface MerchantRecentActivity {
  eventName: string;
  occurredAt: string;
  promotionId: string | null;
  authenticated: boolean;
  deviceType: string;
}

async function recentActivity(
  venueId: number,
  ownerUserId: string,
  range: MerchantReportRange,
  executor: QueryExecutor
) {
  const rows = await executor<any>`
    SELECT event_name, occurred_at, promotion_id, authenticated, device_type
    FROM merchant_analytics_events
    WHERE venue_id = ${venueId} AND venue_owner_user_id = ${ownerUserId}
      AND occurred_at >= ${range.start} AND occurred_at < ${range.end}
      AND event_name <> 'venue_page_view'
    ORDER BY occurred_at DESC LIMIT 12`;
  return rows.map((row: any): MerchantRecentActivity => ({
    eventName: row.event_name,
    occurredAt: isoValue(row.occurred_at)!,
    promotionId: row.promotion_id,
    authenticated: row.authenticated,
    deviceType: row.device_type,
  }));
}

export interface MerchantReportData {
  generatedAt: string;
  range: MerchantReportRange;
  venue: { id: number; name: string; neighborhood: string };
  summary: MerchantReportSummary;
  audience: MerchantAudienceSnapshot;
  trend: MerchantReportTrendPoint[];
  campaigns: MerchantCampaignReport[];
  comparison: MerchantVenueComparison[];
  recentActivity: MerchantRecentActivity[];
  definitions: {
    uniqueVisits: string;
    uniqueUsers: string;
    conversionRate: string;
    revenueProxy: string;
  };
}

export async function getMerchantReportData(input: {
  venueId: number;
  ownerUserId: string;
  accessibleVenues: Array<{ venueId: number; ownerUserId: string }>;
  range: MerchantReportRange;
  executor?: QueryExecutor;
}): Promise<MerchantReportData> {
  const venue = getVenues().find((item) => item.id === input.venueId);
  if (!venue) throw new RangeError('Venue not found.');
  const executor = input.executor ?? sql;
  const [summary, audience, trend, campaigns, comparison, activity] = await Promise.all([
    reportSummary(input.venueId, input.ownerUserId, input.range, executor),
    audienceSnapshot(input.venueId, executor),
    reportTrend(input.venueId, input.ownerUserId, input.range, executor),
    reportCampaigns(input.venueId, input.ownerUserId, input.range, executor),
    venueComparison(input.accessibleVenues, input.range, executor),
    recentActivity(input.venueId, input.ownerUserId, input.range, executor),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    range: input.range,
    venue: { id: venue.id, name: venue.name, neighborhood: venue.neighborhood },
    summary,
    audience,
    trend,
    campaigns,
    comparison,
    recentActivity: activity,
    definitions: {
      uniqueVisits: 'Distinct 30-minute visits that viewed this venue page.',
      uniqueUsers: 'Signed-in users plus privacy-safe anonymous browser ids; no fingerprinting is used.',
      conversionRate: 'Distinct visits with the action divided by distinct visits that viewed the venue.',
      revenueProxy: 'Clicks, saves, follows, and promotion engagement are intent signals, not attributed revenue.',
    },
  };
}
