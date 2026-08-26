import { getEnv } from './env';
import { sql, type QueryExecutor } from './db';
import { getVenueOwner } from './venueUsers';

export const MERCHANT_ANALYTICS_EVENTS = [
  'venue_page_view', 'website_click', 'call_click', 'directions_click',
  'save', 'unsave', 'share', 'follow', 'unfollow', 'alert_subscribe',
  'alert_unsubscribe', 'promotion_view', 'promotion_click', 'campaign_launch',
  'campaign_pause', 'campaign_end', 'export_generated', 'report_email_sent',
] as const;

export type MerchantAnalyticsEventName = (typeof MERCHANT_ANALYTICS_EVENTS)[number];
export type MerchantDeviceType = 'mobile' | 'tablet' | 'desktop' | 'unknown';

const SERVER_EVENTS = new Set<MerchantAnalyticsEventName>([
  'campaign_launch', 'campaign_pause', 'campaign_end', 'export_generated', 'report_email_sent',
]);

export function isMerchantAnalyticsEvent(value: string): value is MerchantAnalyticsEventName {
  return MERCHANT_ANALYTICS_EVENTS.includes(value as MerchantAnalyticsEventName);
}

export function deviceTypeFromUserAgent(userAgent: string | null | undefined): MerchantDeviceType {
  const value = userAgent || '';
  if (!value) return 'unknown';
  if (/ipad|tablet|kindle|silk/i.test(value)) return 'tablet';
  if (/mobile|iphone|ipod|android/i.test(value)) return 'mobile';
  return 'desktop';
}

function cleanProperties(input: Record<string, unknown> = {}) {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(input).slice(0, 20)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof raw === 'boolean') output[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) output[key] = raw;
    else if (typeof raw === 'string' && raw.trim()) output[key] = raw.trim().slice(0, 120);
  }
  return output;
}

async function sendToPostHog(input: {
  eventName: MerchantAnalyticsEventName;
  userId?: string | null;
  visitorId?: string | null;
  visitId?: string | null;
  venueId: number;
  promotionId?: string | null;
  properties: Record<string, string | number | boolean>;
}) {
  const apiKey = getEnv('POSTHOG_PROJECT_API_KEY');
  if (!apiKey || getEnv('POSTHOG_ENABLED') === 'false') return;
  const distinctId = input.userId
    ? `user:${input.userId}`
    : input.visitorId
      ? `visitor:${input.visitorId}`
      : null;
  if (!distinctId) return;
  const host = (getEnv('POSTHOG_HOST') || 'https://us.i.posthog.com').replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1800);
  try {
    await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event: `merchant_${input.eventName}`,
        properties: {
          distinct_id: distinctId,
          venue_id: input.venueId,
          ...(input.promotionId ? { promotion_id: input.promotionId } : {}),
          ...(input.visitId ? { $session_id: input.visitId } : {}),
          ...input.properties,
        },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    console.warn('[merchant analytics] PostHog delivery failed:', error instanceof Error ? error.message : error);
  } finally {
    clearTimeout(timeout);
  }
}

export async function captureMerchantEvent(input: {
  eventName: MerchantAnalyticsEventName | string;
  venueId: number;
  promotionId?: string | null;
  userId?: string | null;
  visitorId?: string | null;
  visitId?: string | null;
  authenticated?: boolean;
  source?: string;
  deviceType?: MerchantDeviceType;
  properties?: Record<string, unknown>;
  occurredAt?: string;
  executor?: QueryExecutor;
}): Promise<void> {
  if (!isMerchantAnalyticsEvent(input.eventName)) throw new RangeError('Unsupported merchant analytics event.');
  if (!Number.isSafeInteger(input.venueId) || input.venueId <= 0) throw new RangeError('A valid venue is required.');
  if (!SERVER_EVENTS.has(input.eventName) && !input.visitorId) {
    throw new RangeError('Public merchant analytics events require an anonymous visitor id.');
  }
  const executor = input.executor ?? sql;
  const owner = await getVenueOwner(input.venueId, executor);
  if (!owner) return; // Unclaimed venues do not have a merchant report yet.
  const properties = cleanProperties(input.properties);
  const source = (input.source || 'venue_page').trim().slice(0, 80) || 'venue_page';
  const deviceType = input.deviceType ?? 'unknown';
  try {
    await executor`
      INSERT INTO merchant_analytics_events (
        event_name, venue_id, venue_owner_user_id, promotion_id, user_id,
        visitor_id, visit_id, authenticated, source, device_type, properties, occurred_at
      ) VALUES (
        ${input.eventName}, ${input.venueId}, ${owner.user_id}, ${input.promotionId ?? null},
        ${input.userId ?? null}, ${input.visitorId ?? null}, ${input.visitId ?? null},
        ${input.authenticated ?? Boolean(input.userId)}, ${source}, ${deviceType},
        ${JSON.stringify(properties)}::jsonb, ${input.occurredAt ?? new Date().toISOString()}
      )`;
  } catch (error) {
    // Reporting must never break a customer action such as saving, calling,
    // launching a campaign, or downloading an export.
    console.warn('[merchant analytics] first-party capture failed:', error instanceof Error ? error.message : error);
  }
  if (!input.executor) {
    await sendToPostHog({
      eventName: input.eventName,
      userId: input.userId,
      visitorId: input.visitorId,
      visitId: input.visitId,
      venueId: input.venueId,
      promotionId: input.promotionId,
      properties: { authenticated: input.authenticated ?? Boolean(input.userId), source, device_type: deviceType, ...properties },
    });
  }
}
