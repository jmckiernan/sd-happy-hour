import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';

const VISITOR_COOKIE = 'sdhh_analytics_visitor';
const VISIT_COOKIE = 'sdhh_analytics_visit';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MerchantAnalyticsIdentity {
  visitorId: string;
  visitId: string;
}

function validUuid(value: string | undefined): string | null {
  return value && UUID_PATTERN.test(value) ? value : null;
}

/**
 * Opaque first-party ids only: no fingerprinting and no personal data. The
 * visit cookie uses a sliding 30-minute window; the visitor cookie lets the
 * report count one browser as one anonymous visitor across visits.
 */
export function ensureMerchantAnalyticsIdentity(
  cookies: AstroCookies,
  secure: boolean
): MerchantAnalyticsIdentity {
  const visitorId = validUuid(cookies.get(VISITOR_COOKIE)?.value) ?? crypto.randomUUID();
  const visitId = validUuid(cookies.get(VISIT_COOKIE)?.value) ?? crypto.randomUUID();
  const shared = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure };
  cookies.set(VISITOR_COOKIE, visitorId, { ...shared, maxAge: 60 * 60 * 24 * 365 });
  cookies.set(VISIT_COOKIE, visitId, { ...shared, maxAge: 60 * 30 });
  return { visitorId, visitId };
}
