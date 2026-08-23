import { sql, type QueryExecutor } from './db';
import type { PromotionType } from './promotionState';

// A stable two-int advisory-lock namespace. 0x53444848 spells "SDHH" and
// keeps promotion venue locks separate from any future advisory-lock users.
export const PROMOTION_VENUE_LOCK_NAMESPACE = 0x53444848;

export interface PromotionCampaign {
  id: string;
  venueId: number;
  type: PromotionType;
  title: string | null;
  description: string;
  dealCode: string | null;
  imageKey: string | null;
  startsAt: string | null;
  endsAt: string | null;
  createdByUserId: string | null;
  publishedAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
  legacyPromotionVenueId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface PromotionCampaignRow {
  id: string;
  venue_id: number;
  type: PromotionType;
  title: string | null;
  description: string;
  deal_code: string | null;
  image_key: string | null;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  created_by_user_id: string | null;
  published_at: Date | string | null;
  ended_at: Date | string | null;
  cancelled_at: Date | string | null;
  legacy_promotion_venue_id: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function mapPromotionCampaign(row: PromotionCampaignRow): PromotionCampaign {
  return {
    id: row.id,
    venueId: row.venue_id,
    type: row.type,
    title: row.title,
    description: row.description,
    dealCode: row.deal_code,
    imageKey: row.image_key,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    createdByUserId: row.created_by_user_id,
    publishedAt: iso(row.published_at),
    endedAt: iso(row.ended_at),
    cancelledAt: iso(row.cancelled_at),
    legacyPromotionVenueId: row.legacy_promotion_venue_id,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

export interface InsertPromotionCampaignInput {
  venueId: number;
  type: PromotionType;
  title: string | null;
  description: string;
  dealCode: string | null;
  imageKey: string | null;
  startsAt: string | null;
  endsAt: string | null;
  createdByUserId: string;
  publishedAt?: string | null;
  endedAt?: string | null;
  cancelledAt?: string | null;
  legacyPromotionVenueId?: number | null;
}

export interface ReplacePromotionCampaignInput {
  type: PromotionType;
  title: string | null;
  description: string;
  dealCode: string | null;
  imageKey: string | null;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  endedAt: string | null;
  cancelledAt: string | null;
}

export async function getDatabaseNow(executor: QueryExecutor = sql): Promise<string> {
  const rows = await executor<{ now: Date | string }>`SELECT clock_timestamp() AS now`;
  const value = iso(rows[0]?.now ?? null);
  if (!value) throw new Error('Database did not return a valid current timestamp.');
  return value;
}

export async function lockPromotionVenue(executor: QueryExecutor, venueId: number): Promise<void> {
  await executor`
    SELECT pg_advisory_xact_lock(${PROMOTION_VENUE_LOCK_NAMESPACE}, ${venueId})`;
}

export async function getPromotionCampaignById(
  id: string,
  executor: QueryExecutor = sql
): Promise<PromotionCampaign | null> {
  const rows = await executor<PromotionCampaignRow>`
    SELECT * FROM promotion_campaigns WHERE id = ${id}`;
  return rows[0] ? mapPromotionCampaign(rows[0]) : null;
}

export async function getPromotionCampaignByIdForUpdate(
  id: string,
  executor: QueryExecutor
): Promise<PromotionCampaign | null> {
  const rows = await executor<PromotionCampaignRow>`
    SELECT * FROM promotion_campaigns WHERE id = ${id} FOR UPDATE`;
  return rows[0] ? mapPromotionCampaign(rows[0]) : null;
}

export async function getLegacyLinkedPromotionCampaign(
  venueId: number,
  executor: QueryExecutor = sql
): Promise<PromotionCampaign | null> {
  const rows = await executor<PromotionCampaignRow>`
    SELECT * FROM promotion_campaigns
    WHERE legacy_promotion_venue_id = ${venueId}`;
  return rows[0] ? mapPromotionCampaign(rows[0]) : null;
}

export async function getLegacyLinkedPromotionCampaignForUpdate(
  venueId: number,
  executor: QueryExecutor
): Promise<PromotionCampaign | null> {
  const rows = await executor<PromotionCampaignRow>`
    SELECT * FROM promotion_campaigns
    WHERE legacy_promotion_venue_id = ${venueId}
    FOR UPDATE`;
  return rows[0] ? mapPromotionCampaign(rows[0]) : null;
}

export async function listLegacyLinkedPromotionCampaigns(
  executor: QueryExecutor = sql
): Promise<PromotionCampaign[]> {
  const rows = await executor<PromotionCampaignRow>`
    SELECT * FROM promotion_campaigns
    WHERE legacy_promotion_venue_id IS NOT NULL
    ORDER BY updated_at ASC, id ASC`;
  return rows.map(mapPromotionCampaign);
}

export async function listPromotionCampaignsByVenue(
  venueId: number,
  executor: QueryExecutor = sql
): Promise<PromotionCampaign[]> {
  const rows = await executor<PromotionCampaignRow>`
    SELECT * FROM promotion_campaigns
    WHERE venue_id = ${venueId}
    ORDER BY created_at DESC, id DESC`;
  return rows.map(mapPromotionCampaign);
}

export async function listLivePromotionCampaigns(
  now: string,
  venueId?: number,
  executor: QueryExecutor = sql
): Promise<PromotionCampaign[]> {
  const rows = venueId === undefined
    ? await executor<PromotionCampaignRow>`
        SELECT * FROM promotion_campaigns
        WHERE published_at IS NOT NULL
          AND cancelled_at IS NULL
          AND starts_at <= ${now}
          AND CASE
                WHEN ended_at IS NOT NULL AND ended_at < ends_at THEN ended_at
                ELSE ends_at
              END > ${now}
        ORDER BY ends_at ASC, id ASC`
    : await executor<PromotionCampaignRow>`
        SELECT * FROM promotion_campaigns
        WHERE venue_id = ${venueId}
          AND published_at IS NOT NULL
          AND cancelled_at IS NULL
          AND starts_at <= ${now}
          AND CASE
                WHEN ended_at IS NOT NULL AND ended_at < ends_at THEN ended_at
                ELSE ends_at
              END > ${now}
        ORDER BY ends_at ASC, id ASC`;
  return rows.map(mapPromotionCampaign);
}

export async function insertPromotionCampaign(
  executor: QueryExecutor,
  input: InsertPromotionCampaignInput
): Promise<PromotionCampaign> {
  const rows = await executor<PromotionCampaignRow>`
    INSERT INTO promotion_campaigns (
      venue_id, type, title, description, deal_code, image_key, starts_at, ends_at,
      created_by_user_id, published_at, ended_at, cancelled_at,
      legacy_promotion_venue_id
    ) VALUES (
      ${input.venueId}, ${input.type}, ${input.title}, ${input.description},
      ${input.dealCode}, ${input.imageKey}, ${input.startsAt}, ${input.endsAt},
      ${input.createdByUserId}, ${input.publishedAt ?? null},
      ${input.endedAt ?? null}, ${input.cancelledAt ?? null},
      ${input.legacyPromotionVenueId ?? null}
    )
    RETURNING *`;
  return mapPromotionCampaign(rows[0]);
}

export async function replacePromotionCampaign(
  executor: QueryExecutor,
  id: string,
  input: ReplacePromotionCampaignInput
): Promise<PromotionCampaign | null> {
  const rows = await executor<PromotionCampaignRow>`
    UPDATE promotion_campaigns SET
      type = ${input.type},
      title = ${input.title},
      description = ${input.description},
      deal_code = ${input.dealCode},
      image_key = ${input.imageKey},
      starts_at = ${input.startsAt},
      ends_at = ${input.endsAt},
      published_at = ${input.publishedAt},
      ended_at = ${input.endedAt},
      cancelled_at = ${input.cancelledAt}
    WHERE id = ${id}
    RETURNING *`;
  return rows[0] ? mapPromotionCampaign(rows[0]) : null;
}

export async function deleteUnpublishedPromotionCampaign(
  executor: QueryExecutor,
  id: string
): Promise<boolean> {
  const rows = await executor<{ id: string }>`
    DELETE FROM promotion_campaigns
    WHERE id = ${id} AND published_at IS NULL
    RETURNING id`;
  return Boolean(rows[0]);
}
