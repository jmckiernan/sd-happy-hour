import { sql, type QueryExecutor } from './db';
import type { VenueAccessRole } from './venueUsers';

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
  accessRole: VenueAccessRole;
}

interface VerifiedPromotionClaimRow {
  id: string;
  user_id: string;
  venue_id: number;
  plan: 'free' | 'paid';
  access_role: VenueAccessRole;
}

function mapClaim(row: VerifiedPromotionClaimRow): VerifiedPromotionClaim {
  return {
    id: row.id,
    userId: row.user_id,
    venueId: row.venue_id,
    plan: row.plan,
    accessRole: row.access_role,
  };
}

export async function getVerifiedPromotionClaim(
  userId: string,
  venueId: number,
  executor: QueryExecutor = sql
): Promise<VerifiedPromotionClaim | null> {
  const rows = await executor<VerifiedPromotionClaimRow>`
    SELECT id, user_id, venue_id, plan, access_role FROM (
      SELECT id, user_id, venue_id, plan, 'owner'::text AS access_role
      FROM venue_claims WHERE user_id = ${userId} AND venue_id = ${venueId} AND status = 'verified'
      UNION ALL
      SELECT m.id, m.user_id, m.venue_id, c.plan, m.role AS access_role
      FROM venue_managers m JOIN venue_claims c ON c.venue_id = m.venue_id AND c.status = 'verified'
      WHERE m.user_id = ${userId} AND m.venue_id = ${venueId}
    ) access LIMIT 1`;
  return rows[0] ? mapClaim(rows[0]) : null;
}

/** Admin reporting needs the venue's plan without impersonating its owner. */
export async function getVerifiedPromotionClaimByVenue(
  venueId: number,
  executor: QueryExecutor = sql
): Promise<VerifiedPromotionClaim | null> {
  const rows = await executor<VerifiedPromotionClaimRow>`
    SELECT id, user_id, venue_id, plan, 'owner'::text AS access_role
    FROM venue_claims
    WHERE venue_id = ${venueId} AND status = 'verified'`;
  return rows[0] ? mapClaim(rows[0]) : null;
}

/** Hold the verified authorization decision stable until the mutation commits. */
export async function getVerifiedPromotionClaimForShare(
  userId: string,
  venueId: number,
  executor: QueryExecutor
): Promise<VerifiedPromotionClaim | null> {
  const ownerRows = await executor<VerifiedPromotionClaimRow>`
    SELECT id, user_id, venue_id, plan, 'owner'::text AS access_role
    FROM venue_claims WHERE user_id = ${userId} AND venue_id = ${venueId} AND status = 'verified'
    FOR SHARE`;
  if (ownerRows[0]) return mapClaim(ownerRows[0]);
  const managerRows = await executor<VerifiedPromotionClaimRow>`
    SELECT m.id, m.user_id, m.venue_id, c.plan, m.role AS access_role
    FROM venue_managers m JOIN venue_claims c ON c.venue_id = m.venue_id AND c.status = 'verified'
    WHERE m.user_id = ${userId} AND m.venue_id = ${venueId}
    FOR SHARE OF m, c`;
  return managerRows[0] ? mapClaim(managerRows[0]) : null;
}
