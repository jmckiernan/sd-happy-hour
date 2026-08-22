import { sql, type QueryExecutor } from './db';

/**
 * Promotion management deliberately has a stricter authorization boundary
 * than listing/photo/menu management: an admin email is not a substitute for
 * a verified claim on this exact venue.
 */
export interface VerifiedPromotionClaim {
  id: string;
  userId: string;
  venueId: number;
  plan: 'free' | 'paid';
}

interface VerifiedPromotionClaimRow {
  id: string;
  user_id: string;
  venue_id: number;
  plan: 'free' | 'paid';
}

function mapClaim(row: VerifiedPromotionClaimRow): VerifiedPromotionClaim {
  return {
    id: row.id,
    userId: row.user_id,
    venueId: row.venue_id,
    plan: row.plan,
  };
}

export async function getVerifiedPromotionClaim(
  userId: string,
  venueId: number,
  executor: QueryExecutor = sql
): Promise<VerifiedPromotionClaim | null> {
  const rows = await executor<VerifiedPromotionClaimRow>`
    SELECT id, user_id, venue_id, plan
    FROM venue_claims
    WHERE user_id = ${userId} AND venue_id = ${venueId} AND status = 'verified'`;
  return rows[0] ? mapClaim(rows[0]) : null;
}

/** Hold the verified authorization decision stable until the mutation commits. */
export async function getVerifiedPromotionClaimForShare(
  userId: string,
  venueId: number,
  executor: QueryExecutor
): Promise<VerifiedPromotionClaim | null> {
  const rows = await executor<VerifiedPromotionClaimRow>`
    SELECT id, user_id, venue_id, plan
    FROM venue_claims
    WHERE user_id = ${userId} AND venue_id = ${venueId} AND status = 'verified'
    FOR SHARE`;
  return rows[0] ? mapClaim(rows[0]) : null;
}
