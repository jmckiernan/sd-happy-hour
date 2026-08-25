import crypto from 'node:crypto';
import { getEnv } from './env';
import { sql, withTransaction, type QueryExecutor } from './db';
import { marketAreaForCoordinates, marketAreaLabel } from './marketAreas';

export const PRODUCT_EVENTS = [
  'account_created',
  'login_completed',
  'venue_viewed',
  'near_me_used',
  'directions_opened',
  'venue_saved',
  'venue_unsaved',
  'list_created',
  'list_shared',
  'share_invite_accepted',
  'list_venue_added',
  'alert_enabled',
  'alert_disabled',
  'restaurant_claim_started',
  'restaurant_claim_completed',
  'promotion_created',
  'promotion_launched',
] as const;

export type ProductEventName = (typeof PRODUCT_EVENTS)[number];

const EVENT_PROPERTIES: Record<ProductEventName, readonly string[]> = {
  account_created: ['method'],
  login_completed: ['method'],
  venue_viewed: ['venue_id', 'area_key'],
  near_me_used: ['area_key'],
  directions_opened: ['venue_id', 'area_key'],
  venue_saved: ['venue_id', 'list_type'],
  venue_unsaved: ['venue_id', 'list_type'],
  list_created: ['list_type'],
  list_shared: ['role', 'method'],
  share_invite_accepted: ['role', 'method'],
  list_venue_added: ['venue_id', 'list_type'],
  alert_enabled: ['alert_type', 'channel'],
  alert_disabled: ['alert_type', 'channel'],
  restaurant_claim_started: ['venue_id'],
  restaurant_claim_completed: ['venue_id', 'verification_method'],
  promotion_created: ['venue_id', 'promotion_type'],
  promotion_launched: ['venue_id', 'promotion_type'],
};

const SESSION_IDLE_SECONDS = 30 * 60;
const MAX_PROPERTY_STRING_LENGTH = 80;

interface ActivitySessionRow {
  id: string;
  user_id: string;
  started_at: Date | string;
  last_seen_at: Date | string;
  ended_at: Date | string | null;
}

function cleanProperties(eventName: ProductEventName, input: Record<string, unknown> = {}) {
  const allowed = new Set(EVENT_PROPERTIES[eventName]);
  const output: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    if (typeof raw === 'number' && Number.isFinite(raw)) output[key] = raw;
    else if (typeof raw === 'boolean') output[key] = raw;
    else if (typeof raw === 'string' && raw.trim()) output[key] = raw.trim().slice(0, MAX_PROPERTY_STRING_LENGTH);
  }
  return output;
}

function isProductEventName(value: string): value is ProductEventName {
  return PRODUCT_EVENTS.includes(value as ProductEventName);
}

async function incrementDailyEngagement(
  executor: QueryExecutor,
  userId: string,
  input: { sessions?: number; activeSeconds?: number; meaningfulEvents?: number }
) {
  await executor`
    INSERT INTO user_engagement_daily (
      user_id, activity_date, session_count, active_seconds, meaningful_events
    ) VALUES (
      ${userId}, current_date, ${input.sessions || 0},
      ${input.activeSeconds || 0}, ${input.meaningfulEvents || 0}
    )
    ON CONFLICT (user_id, activity_date) DO UPDATE SET
      session_count = user_engagement_daily.session_count + EXCLUDED.session_count,
      active_seconds = user_engagement_daily.active_seconds + EXCLUDED.active_seconds,
      meaningful_events = user_engagement_daily.meaningful_events + EXCLUDED.meaningful_events`;
}

export interface ActivityTouchResult {
  sessionId: string;
  startedNewSession: boolean;
}

export async function touchActivitySession(
  userId: string,
  requestedSessionId: string | null
): Promise<ActivityTouchResult> {
  return withTransaction(async (tx) => {
    const now = new Date();
    let current: ActivitySessionRow | undefined;
    if (requestedSessionId && /^[0-9a-f-]{36}$/i.test(requestedSessionId)) {
      const rows = await tx<ActivitySessionRow>`
        SELECT * FROM user_activity_sessions
        WHERE id = ${requestedSessionId} AND user_id = ${userId}
        FOR UPDATE`;
      current = rows[0];
    }

    if (current && !current.ended_at) {
      const previous = new Date(current.last_seen_at);
      const deltaSeconds = Math.max(0, Math.floor((now.getTime() - previous.getTime()) / 1000));
      if (deltaSeconds <= SESSION_IDLE_SECONDS) {
        await tx`UPDATE user_activity_sessions SET last_seen_at = ${now.toISOString()} WHERE id = ${current.id}`;
        if (deltaSeconds) await incrementDailyEngagement(tx, userId, { activeSeconds: deltaSeconds });
        await tx`
          UPDATE users SET last_activity_at = ${now.toISOString()}
          WHERE id = ${userId}
            AND account_status = 'active'
            AND (last_activity_at IS NULL OR last_activity_at < ${new Date(now.getTime() - 5 * 60 * 1000).toISOString()})`;
        return { sessionId: current.id, startedNewSession: false };
      }
      await tx`
        UPDATE user_activity_sessions
        SET ended_at = last_seen_at
        WHERE id = ${current.id} AND ended_at IS NULL`;
    }

    const sessionId = crypto.randomUUID();
    await tx`
      INSERT INTO user_activity_sessions (id, user_id, started_at, last_seen_at)
      SELECT ${sessionId}, id, ${now.toISOString()}, ${now.toISOString()}
      FROM users WHERE id = ${userId} AND account_status = 'active'`;
    await incrementDailyEngagement(tx, userId, { sessions: 1 });
    await tx`UPDATE users SET last_activity_at = ${now.toISOString()} WHERE id = ${userId} AND account_status = 'active'`;
    return { sessionId, startedNewSession: true };
  });
}

async function sendToPostHog(
  eventName: ProductEventName,
  userId: string | null,
  sessionId: string | null,
  properties: Record<string, string | number | boolean>
) {
  const apiKey = getEnv('POSTHOG_PROJECT_API_KEY');
  if (!apiKey || getEnv('POSTHOG_ENABLED') === 'false') return;
  const host = (getEnv('POSTHOG_HOST') || 'https://us.i.posthog.com').replace(/\/$/, '');
  const distinctId = userId ? `user:${userId}` : sessionId ? `session:${sessionId}` : null;
  if (!distinctId) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1800);
  try {
    await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event: eventName,
        properties: {
          distinct_id: distinctId,
          ...(sessionId ? { $session_id: sessionId } : {}),
          ...properties,
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    console.warn('[product analytics] PostHog delivery failed:', error instanceof Error ? error.message : error);
  } finally {
    clearTimeout(timeout);
  }
}

export async function captureProductEvent(input: {
  eventName: ProductEventName | string;
  userId?: string | null;
  sessionId?: string | null;
  properties?: Record<string, unknown>;
}): Promise<void> {
  if (!isProductEventName(input.eventName)) throw new RangeError('Unsupported analytics event.');
  const properties = cleanProperties(input.eventName, input.properties);
  try {
    await sql`
      INSERT INTO product_analytics_events (user_id, session_id, event_name, properties)
      VALUES (${input.userId || null}, ${input.sessionId || null}, ${input.eventName}, ${JSON.stringify(properties)}::jsonb)`;
    if (input.userId) await incrementDailyEngagement(sql, input.userId, { meaningfulEvents: 1 });
  } catch (error) {
    // Analytics must never make sign-in, saving, or alert setup fail.
    console.warn('[product analytics] first-party capture failed:', error instanceof Error ? error.message : error);
  }
  await sendToPostHog(input.eventName, input.userId || null, input.sessionId || null, properties);
}

export async function recordNearMeArea(
  userId: string,
  latitude: number,
  longitude: number
): Promise<{ areaKey: string; areaLabel: string }> {
  const areaKey = marketAreaForCoordinates(latitude, longitude);
  await withTransaction(async (tx) => {
    const users = await tx<{ id: string }>`
      UPDATE users SET
        location_analytics_consent_at = COALESCE(location_analytics_consent_at, now()),
        location_analytics_revoked_at = NULL
      WHERE id = ${userId} AND account_status = 'active'
      RETURNING id`;
    if (!users[0]) throw new RangeError('An active user account is required.');
    await tx`
      INSERT INTO user_area_activity_daily (
        user_id, area_key, activity_date, source
      ) VALUES (${userId}, ${areaKey}, current_date, 'near_me')
      ON CONFLICT (user_id, area_key, activity_date, source) DO UPDATE SET
        event_count = user_area_activity_daily.event_count + 1,
        last_seen_at = now()`;
  });
  return { areaKey, areaLabel: marketAreaLabel(areaKey) };
}

export async function setLocationAnalyticsConsent(userId: string, enabled: boolean): Promise<void> {
  await withTransaction(async (tx) => {
    if (enabled) {
      await tx`
        UPDATE users SET
          location_analytics_consent_at = COALESCE(location_analytics_consent_at, now()),
          location_analytics_revoked_at = NULL
        WHERE id = ${userId} AND account_status = 'active'`;
      return;
    }
    await tx`
      UPDATE users SET location_analytics_consent_at = NULL, location_analytics_revoked_at = now()
      WHERE id = ${userId}`;
    await tx`DELETE FROM user_area_activity_daily WHERE user_id = ${userId}`;
  });
}

export async function recordNotificationMetric(input: {
  userId: string;
  channel: 'email' | 'text';
  status: 'sent' | 'delivered' | 'failed' | 'simulated';
}): Promise<void> {
  await sql`
    INSERT INTO user_notification_daily_metrics (
      user_id, metric_date, channel, sent_count, delivered_count, failed_count, simulated_count
    ) VALUES (
      ${input.userId}, current_date, ${input.channel},
      ${input.status === 'sent' ? 1 : 0}, ${input.status === 'delivered' ? 1 : 0},
      ${input.status === 'failed' ? 1 : 0}, ${input.status === 'simulated' ? 1 : 0}
    )
    ON CONFLICT (user_id, metric_date, channel) DO UPDATE SET
      sent_count = user_notification_daily_metrics.sent_count + EXCLUDED.sent_count,
      delivered_count = user_notification_daily_metrics.delivered_count + EXCLUDED.delivered_count,
      failed_count = user_notification_daily_metrics.failed_count + EXCLUDED.failed_count,
      simulated_count = user_notification_daily_metrics.simulated_count + EXCLUDED.simulated_count`;
}

export async function pruneProductAnalyticsData(retentionDays = 90): Promise<void> {
  const days = Math.max(30, Math.min(365, Math.floor(retentionDays)));
  await withTransaction(async (tx) => {
    await tx`DELETE FROM product_analytics_events WHERE created_at < now() - make_interval(days => ${days})`;
    await tx`DELETE FROM user_activity_sessions WHERE started_at < now() - make_interval(days => ${days})`;
    await tx`DELETE FROM user_area_activity_daily WHERE activity_date < current_date - ${days}::integer`;
  });
}

export function isSupportedProductEvent(value: string): value is ProductEventName {
  return isProductEventName(value);
}
