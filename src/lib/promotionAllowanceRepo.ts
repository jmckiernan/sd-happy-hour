import { sql, type QueryExecutor } from './db';

export interface VenuePromotionAllowance {
  venueId: number;
  monthKey: string;
  additionalAllowance: number;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface VenuePromotionAllowanceRow {
  venue_id: number;
  month_key: string;
  additional_allowance: number;
  updated_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapAllowance(row: VenuePromotionAllowanceRow): VenuePromotionAllowance {
  return {
    venueId: row.venue_id,
    monthKey: row.month_key,
    additionalAllowance: row.additional_allowance,
    updatedByUserId: row.updated_by_user_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function getAdditionalPromotionAllowance(
  venueId: number,
  monthKey: string,
  executor: QueryExecutor = sql
): Promise<number> {
  const rows = await executor<{ additional_allowance: number }>`
    SELECT additional_allowance
    FROM venue_promotion_allowances
    WHERE venue_id = ${venueId} AND month_key = ${monthKey}`;
  return rows[0]?.additional_allowance ?? 0;
}

/** Atomically grants one more slot and returns the updated monthly record. */
export async function addPromotionAllowance(
  executor: QueryExecutor,
  venueId: number,
  monthKey: string,
  adminUserId: string
): Promise<VenuePromotionAllowance> {
  const rows = await executor<VenuePromotionAllowanceRow>`
    INSERT INTO venue_promotion_allowances (
      venue_id, month_key, additional_allowance, updated_by_user_id
    ) VALUES (${venueId}, ${monthKey}, 1, ${adminUserId})
    ON CONFLICT (venue_id, month_key) DO UPDATE SET
      additional_allowance = venue_promotion_allowances.additional_allowance + 1,
      updated_by_user_id = EXCLUDED.updated_by_user_id
    RETURNING *`;
  return mapAllowance(rows[0]);
}

/** Atomically removes one admin-granted slot, never reducing the base plan allowance. */
export async function removePromotionAllowance(
  executor: QueryExecutor,
  venueId: number,
  monthKey: string,
  adminUserId: string
): Promise<VenuePromotionAllowance | null> {
  const rows = await executor<VenuePromotionAllowanceRow>`
    UPDATE venue_promotion_allowances SET
      additional_allowance = additional_allowance - 1,
      updated_by_user_id = ${adminUserId}
    WHERE venue_id = ${venueId}
      AND month_key = ${monthKey}
      AND additional_allowance > 0
    RETURNING *`;
  return rows[0] ? mapAllowance(rows[0]) : null;
}
