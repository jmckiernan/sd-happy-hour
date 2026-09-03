import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { isAdminEmail } from './adminIdentity';
import { sql, withTransaction, type QueryExecutor } from './db';
import { getSession } from './session';
import { getUserById } from './store';
import { getVenueAccess, type VenueAccessRole } from './venueUsers';
import { getVenues, venueSlug } from './venues';
import { parseSanDiegoLocalDateTime } from './sanDiegoTime';

export type MerchantEntitlementSource = 'legacy_paid' | 'admin_grant' | 'access_code' | 'billing';

export interface MerchantEntitlement {
  venueId: number;
  source: MerchantEntitlementSource;
  accessStartsAt: string;
  accessEndsAt: string | null;
  active: boolean;
}

export interface MerchantReportVenue {
  venueId: number;
  ownerUserId: string;
  venueName: string;
  venueSlug: string;
  neighborhood: string;
  role: VenueAccessRole | 'site_admin';
  paid: boolean;
  entitlementEndsAt: string | null;
}

interface EntitlementRow {
  venue_id: number;
  source: MerchantEntitlementSource;
  access_starts_at: Date | string;
  access_ends_at: Date | string | null;
  active: boolean;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function mapEntitlement(row: EntitlementRow): MerchantEntitlement {
  return {
    venueId: row.venue_id,
    source: row.source,
    accessStartsAt: iso(row.access_starts_at)!,
    accessEndsAt: iso(row.access_ends_at),
    active: row.active,
  };
}

export async function getMerchantEntitlement(
  venueId: number,
  executor: QueryExecutor = sql
): Promise<MerchantEntitlement | null> {
  const rows = await executor<EntitlementRow>`
    SELECT venue_id, source, access_starts_at, access_ends_at,
      access_starts_at <= now() AND (access_ends_at IS NULL OR access_ends_at > now()) AS active
    FROM merchant_entitlements
    WHERE venue_id = ${venueId}`;
  if (rows[0]) return mapEntitlement(rows[0]);

  // Safe compatibility during rolling deploys and for a paid claim created by
  // older admin tooling after the migration ran.
  const legacy = await executor<{ venue_id: number; created_at: Date | string }>`
    SELECT venue_id, created_at FROM venue_claims
    WHERE venue_id = ${venueId} AND status = 'verified' AND plan = 'paid'`;
  return legacy[0]
    ? {
        venueId: legacy[0].venue_id,
        source: 'legacy_paid',
        accessStartsAt: iso(legacy[0].created_at)!,
        accessEndsAt: null,
        active: true,
      }
    : null;
}

export async function hasMerchantReportingAccess(
  venueId: number,
  executor: QueryExecutor = sql
): Promise<boolean> {
  return Boolean((await getMerchantEntitlement(venueId, executor))?.active);
}

async function accessibleVenueRows(userId: string, siteAdmin: boolean, executor: QueryExecutor = sql) {
  if (siteAdmin) {
    return executor<{ venue_id: number; owner_user_id: string; role: 'site_admin' }>`
      SELECT venue_id, user_id AS owner_user_id, 'site_admin'::text AS role
      FROM venue_claims WHERE status = 'verified'
      ORDER BY created_at ASC, venue_id ASC`;
  }
  return executor<{ venue_id: number; owner_user_id: string; role: VenueAccessRole }>`
    SELECT venue_id, owner_user_id, role FROM (
      SELECT venue_id, user_id AS owner_user_id, 'owner'::text AS role, created_at
      FROM venue_claims
      WHERE user_id = ${userId} AND status = 'verified'
      UNION ALL
      SELECT m.venue_id, c.user_id AS owner_user_id, m.role, m.created_at
      FROM venue_managers m
      JOIN venue_claims c ON c.venue_id = m.venue_id AND c.status = 'verified'
      WHERE m.user_id = ${userId} AND m.role = 'full_admin'
    ) report_access
    ORDER BY created_at ASC, venue_id ASC`;
}

export async function listMerchantReportVenues(
  userId: string,
  siteAdmin: boolean,
  executor: QueryExecutor = sql
): Promise<MerchantReportVenue[]> {
  const rows = await accessibleVenueRows(userId, siteAdmin, executor);
  const venueById = new Map(getVenues().map((venue) => [venue.id, venue]));
  return Promise.all(rows.flatMap(async (row) => {
    const venue = venueById.get(row.venue_id);
    if (!venue) return [];
    const entitlement = await getMerchantEntitlement(row.venue_id, executor);
    return [{
      venueId: venue.id,
      ownerUserId: row.owner_user_id,
      venueName: venue.name,
      venueSlug: venueSlug(venue),
      neighborhood: venue.neighborhood,
      role: row.role,
      paid: siteAdmin || Boolean(entitlement?.active),
      entitlementEndsAt: entitlement?.accessEndsAt ?? null,
    }];
  })).then((items) => items.flat());
}

export interface MerchantReportAuthorization {
  userId: string;
  email: string;
  siteAdmin: boolean;
  venue: MerchantReportVenue;
}

export function canAccessMerchantReports(role: VenueAccessRole | 'site_admin' | null | undefined): boolean {
  return role === 'owner' || role === 'full_admin' || role === 'site_admin';
}

export async function authorizeMerchantReport(
  cookies: AstroCookies,
  venueId: number,
  options: { requirePaid?: boolean } = {}
): Promise<MerchantReportAuthorization | null> {
  const session = await getSession(cookies);
  if (!session) return null;
  const user = await getUserById(session.userId);
  if (!user) return null;
  const siteAdmin = isAdminEmail(user.email);
  if (!siteAdmin) {
    const access = await getVenueAccess(user.id, venueId);
    if (!access || !canAccessMerchantReports(access.role)) return null;
  }
  const venue = (await listMerchantReportVenues(user.id, siteAdmin)).find((item) => item.venueId === venueId);
  if (!venue || (options.requirePaid !== false && !venue.paid)) return null;
  return { userId: user.id, email: user.email, siteAdmin, venue };
}

export async function grantMerchantReportingAccess(input: {
  venueId: number;
  grantedByUserId: string;
  durationMonths?: number | null;
}, executor: QueryExecutor = sql): Promise<MerchantEntitlement> {
  const months = input.durationMonths == null ? null : Math.floor(input.durationMonths);
  if (months !== null && (months < 1 || months > 36)) {
    throw new RangeError('Grant duration must be between 1 and 36 months.');
  }
  const rows = await executor<EntitlementRow>`
    INSERT INTO merchant_entitlements (
      venue_id, source, access_starts_at, access_ends_at, code_redemption_id, granted_by_user_id
    ) VALUES (
      ${input.venueId}, 'admin_grant', now(),
      CASE WHEN ${months}::integer IS NULL THEN NULL ELSE now() + make_interval(months => ${months}) END,
      NULL, ${input.grantedByUserId}
    )
    ON CONFLICT (venue_id) DO UPDATE SET
      source = 'admin_grant',
      access_starts_at = now(),
      access_ends_at = CASE WHEN ${months}::integer IS NULL THEN NULL ELSE now() + make_interval(months => ${months}) END,
      code_redemption_id = NULL,
      granted_by_user_id = EXCLUDED.granted_by_user_id
    RETURNING venue_id, source, access_starts_at, access_ends_at, true AS active`;
  return mapEntitlement(rows[0]);
}

export async function revokeMerchantReportingAccess(venueId: number, executor: QueryExecutor = sql): Promise<void> {
  await executor`DELETE FROM merchant_entitlements WHERE venue_id = ${venueId}`;
  // The legacy flag is a compatibility entitlement, so revocation must clear
  // it as well or the fallback above would immediately restore access.
  await executor`UPDATE venue_claims SET plan = 'free' WHERE venue_id = ${venueId} AND status = 'verified'`;
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function codeHash(value: string): string {
  return crypto.createHash('sha256').update(normalizeCode(value)).digest('hex');
}

export function generateMerchantAccessCode(): string {
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `SDHH-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export async function createMerchantAccessCode(input: {
  durationMonths: number;
  createdByUserId: string;
  expiresAt?: string | null;
  maxRedemptions?: number;
}): Promise<{ id: string; code: string; durationMonths: number; expiresAt: string | null }> {
  const durationMonths = Math.floor(input.durationMonths);
  const maxRedemptions = Math.floor(input.maxRedemptions ?? 1);
  if (durationMonths < 1 || durationMonths > 36) throw new RangeError('Duration must be between 1 and 36 months.');
  if (maxRedemptions < 1 || maxRedemptions > 1000) throw new RangeError('Redemption limit must be between 1 and 1000.');
  let expiresAt = input.expiresAt ?? null;
  if (expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    const [year, month, day] = expiresAt.split('-').map(Number);
    const original = new Date(Date.UTC(year, month - 1, day));
    if (original.getUTCFullYear() !== year || original.getUTCMonth() + 1 !== month || original.getUTCDate() !== day) {
      throw new RangeError('Code expiration must be a valid date.');
    }
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    const nextKey = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
    const parsedExpiration = parseSanDiegoLocalDateTime(`${nextKey}T00:00`, { disambiguation: 'earlier' });
    if (!parsedExpiration) throw new RangeError('Code expiration must be a valid date.');
    expiresAt = parsedExpiration.toISOString();
  }
  if (expiresAt && !Number.isFinite(new Date(expiresAt).getTime())) throw new RangeError('Code expiration must be a valid date.');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateMerchantAccessCode();
    try {
      const rows = await sql<{ id: string; expires_at: Date | string | null }>`
        INSERT INTO merchant_access_codes (
          code_hash, code_hint, duration_months, max_redemptions, expires_at, created_by_user_id
        ) VALUES (
          ${codeHash(code)}, ${code.slice(-4)}, ${durationMonths}, ${maxRedemptions},
          ${expiresAt}, ${input.createdByUserId}
        ) RETURNING id, expires_at`;
      return { id: rows[0].id, code, durationMonths, expiresAt: iso(rows[0].expires_at) };
    } catch (error: any) {
      if (error?.code !== '23505' || attempt === 2) throw error;
    }
  }
  throw new Error('Could not generate a unique access code.');
}

export async function listMerchantAccessCodes(executor: QueryExecutor = sql) {
  const rows = await executor<{
    id: string; code_hint: string; duration_months: number; max_redemptions: number;
    redemption_count: number; active: boolean; expires_at: Date | string | null; created_at: Date | string;
  }>`SELECT id, code_hint, duration_months, max_redemptions, redemption_count, active, expires_at, created_at
      FROM merchant_access_codes ORDER BY created_at DESC LIMIT 100`;
  const now = Date.now();
  return rows.map((row) => {
    const expiresAt = iso(row.expires_at);
    const expired = expiresAt ? new Date(expiresAt).getTime() <= now : false;
    return {
      id: row.id,
      codeHint: row.code_hint,
      durationMonths: row.duration_months,
      maxRedemptions: row.max_redemptions,
      redemptionCount: row.redemption_count,
      active: row.active,
      expired,
      expiresAt,
      createdAt: iso(row.created_at),
    };
  });
}

export async function updateMerchantAccessCodeActive(id: string, active: boolean) {
  const rows = await sql<{
    id: string; code_hint: string; duration_months: number; max_redemptions: number;
    redemption_count: number; active: boolean; expires_at: Date | string | null; created_at: Date | string;
  }>`SELECT id, code_hint, duration_months, max_redemptions, redemption_count, active, expires_at, created_at
      FROM merchant_access_codes WHERE id = ${id}`;
  const row = rows[0];
  if (!row) throw new RangeError('Access code not found.');
  const expiresAt = iso(row.expires_at);
  const expired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
  if (active && expired) throw new RangeError('Expired codes cannot be reactivated.');
  const updated = await sql<typeof row>`
    UPDATE merchant_access_codes SET active = ${active} WHERE id = ${id}
    RETURNING id, code_hint, duration_months, max_redemptions, redemption_count, active, expires_at, created_at`;
  const next = updated[0];
  return {
    id: next.id,
    codeHint: next.code_hint,
    durationMonths: next.duration_months,
    maxRedemptions: next.max_redemptions,
    redemptionCount: next.redemption_count,
    active: next.active,
    expired,
    expiresAt: iso(next.expires_at),
    createdAt: iso(next.created_at),
  };
}

export async function redeemMerchantAccessCode(input: {
  code: string;
  venueId: number;
  userId: string;
}): Promise<MerchantEntitlement> {
  const hash = codeHash(input.code);
  if (normalizeCode(input.code).length < 8) throw new RangeError('Enter a valid access code.');
  return withTransaction(async (tx) => {
    const access = await getVenueAccess(input.userId, input.venueId, tx);
    if (!access || access.role !== 'owner') throw new RangeError('Only the restaurant owner can redeem an access code.');
    const existing = await getMerchantEntitlement(input.venueId, tx);
    if (existing?.active && existing.accessEndsAt === null) {
      throw new RangeError('This restaurant already has ongoing reporting access.');
    }
    const codes = await tx<{
      id: string; duration_months: number; max_redemptions: number; redemption_count: number;
      active: boolean; expires_at: Date | string | null;
    }>`SELECT id, duration_months, max_redemptions, redemption_count, active, expires_at
        FROM merchant_access_codes WHERE code_hash = ${hash} FOR UPDATE`;
    const code = codes[0];
    if (!code || !code.active || code.redemption_count >= code.max_redemptions ||
        (code.expires_at && new Date(code.expires_at).getTime() <= Date.now())) {
      throw new RangeError('This access code is invalid, expired, or already used.');
    }
    const redemptions = await tx<{ id: string; access_starts_at: Date | string; access_ends_at: Date | string }>`
      INSERT INTO merchant_access_code_redemptions (
        access_code_id, venue_id, redeemed_by_user_id, access_starts_at, access_ends_at
      ) VALUES (
        ${code.id}, ${input.venueId}, ${input.userId},
        GREATEST(now(), COALESCE(${existing?.accessEndsAt ?? null}::timestamptz, now())),
        GREATEST(now(), COALESCE(${existing?.accessEndsAt ?? null}::timestamptz, now()))
          + make_interval(months => ${code.duration_months})
      ) RETURNING id, access_starts_at, access_ends_at`;
    await tx`UPDATE merchant_access_codes SET redemption_count = redemption_count + 1 WHERE id = ${code.id}`;
    const entitlementRows = await tx<EntitlementRow>`
      INSERT INTO merchant_entitlements (
        venue_id, source, access_starts_at, access_ends_at, code_redemption_id, granted_by_user_id
      ) VALUES (
        ${input.venueId}, 'access_code', ${redemptions[0].access_starts_at},
        ${redemptions[0].access_ends_at}, ${redemptions[0].id}, NULL
      )
      ON CONFLICT (venue_id) DO UPDATE SET
        source = 'access_code',
        access_starts_at = LEAST(merchant_entitlements.access_starts_at, EXCLUDED.access_starts_at),
        access_ends_at = EXCLUDED.access_ends_at, code_redemption_id = EXCLUDED.code_redemption_id,
        granted_by_user_id = NULL
      RETURNING venue_id, source, access_starts_at, access_ends_at, true AS active`;
    return mapEntitlement(entitlementRows[0]);
  });
}
