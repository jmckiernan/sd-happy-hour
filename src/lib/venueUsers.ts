import crypto from 'node:crypto';
import { sql, withTransaction, type QueryExecutor } from './db';

export type VenueAccessRole = 'owner' | 'full_admin' | 'promotions';
export type DelegatedVenueRole = Exclude<VenueAccessRole, 'owner'>;

export interface VenueManagerRecord {
  id: string;
  venueId: number;
  userId: string;
  role: DelegatedVenueRole;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
}

export interface VenueManagerInvite {
  id: string;
  venueId: number;
  email: string;
  role: DelegatedVenueRole;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ManagerRow {
  id: string; venue_id: number; user_id: string; role: DelegatedVenueRole;
  name: string; email: string; created_at: string; updated_at: string;
}
interface InviteRow {
  id: string; venue_id: number; email: string; role: DelegatedVenueRole;
  expires_at: string; accepted_at: string | null; revoked_at: string | null;
  created_at: string; updated_at: string;
  invited_by_owner_user_id: string | null;
}

function manager(row: ManagerRow): VenueManagerRecord {
  return { id: row.id, venueId: row.venue_id, userId: row.user_id, role: row.role,
    name: row.name, email: row.email, createdAt: row.created_at, updatedAt: row.updated_at };
}
function invite(row: InviteRow): VenueManagerInvite {
  return { id: row.id, venueId: row.venue_id, email: row.email, role: row.role,
    expiresAt: row.expires_at, acceptedAt: row.accepted_at, revokedAt: row.revoked_at,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function getVenueOwner(venueId: number, executor: QueryExecutor = sql) {
  const rows = await executor<{ claim_id: string; user_id: string; name: string; email: string; plan: 'free' | 'paid' }>`
    SELECT c.id AS claim_id, c.user_id, u.name, u.email, c.plan
    FROM venue_claims c JOIN users u ON u.id = c.user_id
    WHERE c.venue_id = ${venueId} AND c.status = 'verified'`;
  return rows[0] ?? null;
}

export async function getVenueAccess(userId: string, venueId: number, executor: QueryExecutor = sql): Promise<{ role: VenueAccessRole; plan: 'free' | 'paid'; claimId: string | null; managerId: string | null } | null> {
  const ownerRows = await executor<{ id: string; plan: 'free' | 'paid' }>`
    SELECT id, plan FROM venue_claims
    WHERE user_id = ${userId} AND venue_id = ${venueId} AND status = 'verified'`;
  if (ownerRows[0]) return { role: 'owner', plan: ownerRows[0].plan, claimId: ownerRows[0].id, managerId: null };
  const rows = await executor<{ id: string; role: DelegatedVenueRole; plan: 'free' | 'paid' }>`
    SELECT m.id, m.role, c.plan
    FROM venue_managers m
    JOIN venue_claims c ON c.venue_id = m.venue_id AND c.status = 'verified'
    WHERE m.user_id = ${userId} AND m.venue_id = ${venueId}`;
  return rows[0] ? { role: rows[0].role, plan: rows[0].plan, claimId: null, managerId: rows[0].id } : null;
}

export async function listVenueManagers(venueId: number, executor: QueryExecutor = sql) {
  const rows = await executor<ManagerRow>`
    SELECT m.*, u.name, u.email FROM venue_managers m JOIN users u ON u.id = m.user_id
    WHERE m.venue_id = ${venueId} ORDER BY lower(u.name), lower(u.email)`;
  return rows.map(manager);
}

export async function listPendingVenueInvites(venueId: number, executor: QueryExecutor = sql) {
  const rows = await executor<InviteRow>`
    SELECT * FROM venue_manager_invites WHERE venue_id = ${venueId}
      AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
    ORDER BY created_at DESC`;
  return rows.map(invite);
}

export async function listManagedVenueAccessByUser(userId: string, executor: QueryExecutor = sql) {
  return executor<{ manager_id: string; venue_id: number; role: DelegatedVenueRole; plan: 'free' | 'paid' }>`
    SELECT m.id AS manager_id, m.venue_id, m.role, c.plan
    FROM venue_managers m JOIN venue_claims c ON c.venue_id = m.venue_id AND c.status = 'verified'
    WHERE m.user_id = ${userId} ORDER BY m.created_at DESC`;
}

export async function searchUsersForVenue(query: string, executor: QueryExecutor = sql) {
  const normalized = query.trim().toLowerCase();
  if (normalized.includes('@')) {
    const rows = await executor<{ id: string; name: string; email: string }>`
      SELECT id, name, email FROM users WHERE lower(email) = ${normalized} LIMIT 1`;
    return rows;
  }
  if (normalized.length < 3) return [];
  return executor<{ id: string; name: string; email: string }>`
    SELECT id, name, email FROM users
    WHERE lower(name) LIKE ${`%${normalized}%`}
    ORDER BY lower(name), id LIMIT 8`;
}

export async function addVenueManager(venueId: number, userId: string, role: DelegatedVenueRole, ownerUserId: string, executor: QueryExecutor = sql) {
  const rows = await executor<ManagerRow>`
    WITH upserted AS (
      INSERT INTO venue_managers (venue_id, user_id, role, added_by_owner_user_id)
      VALUES (${venueId}, ${userId}, ${role}, ${ownerUserId})
      ON CONFLICT (venue_id, user_id) DO UPDATE SET role = EXCLUDED.role, added_by_owner_user_id = EXCLUDED.added_by_owner_user_id
      RETURNING *
    ) SELECT m.*, u.name, u.email FROM upserted m JOIN users u ON u.id = m.user_id`;
  return manager(rows[0]);
}

export async function updateVenueManagerRole(venueId: number, managerId: string, role: DelegatedVenueRole, executor: QueryExecutor = sql) {
  const rows = await executor<ManagerRow>`
    WITH updated AS (
      UPDATE venue_managers SET role = ${role}
      WHERE id = ${managerId} AND venue_id = ${venueId}
      RETURNING *
    ) SELECT m.*, u.name, u.email FROM updated m JOIN users u ON u.id = m.user_id`;
  return rows[0] ? manager(rows[0]) : null;
}

export async function removeVenueManager(venueId: number, managerId: string, executor: QueryExecutor = sql) {
  const rows = await executor<{ id: string }>`DELETE FROM venue_managers WHERE id = ${managerId} AND venue_id = ${venueId} RETURNING id`;
  return Boolean(rows[0]);
}

export function createInviteToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
}
export function hashInviteToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createVenueInvite(venueId: number, email: string, role: DelegatedVenueRole, ownerUserId: string, tokenHash: string, executor: QueryExecutor = sql) {
  const rows = await executor<InviteRow>`
    INSERT INTO venue_manager_invites (venue_id, email, role, token_hash, invited_by_owner_user_id, expires_at)
    VALUES (${venueId}, ${email.toLowerCase()}, ${role}, ${tokenHash}, ${ownerUserId}, now() + interval '7 days')
    ON CONFLICT (venue_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL
    DO UPDATE SET role = EXCLUDED.role, token_hash = EXCLUDED.token_hash,
      invited_by_owner_user_id = EXCLUDED.invited_by_owner_user_id,
      expires_at = EXCLUDED.expires_at, updated_at = now()
    RETURNING *`;
  return invite(rows[0]);
}

export async function updateVenueInviteRole(venueId: number, inviteId: string, role: DelegatedVenueRole, executor: QueryExecutor = sql) {
  const rows = await executor<InviteRow>`UPDATE venue_manager_invites SET role = ${role}
    WHERE id = ${inviteId} AND venue_id = ${venueId} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING *`;
  return rows[0] ? invite(rows[0]) : null;
}
export async function revokeVenueInvite(venueId: number, inviteId: string, executor: QueryExecutor = sql) {
  const rows = await executor<{ id: string }>`UPDATE venue_manager_invites SET revoked_at = now()
    WHERE id = ${inviteId} AND venue_id = ${venueId} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`;
  return Boolean(rows[0]);
}
export async function revokePendingVenueInviteForEmail(venueId: number, email: string, executor: QueryExecutor = sql) {
  await executor`UPDATE venue_manager_invites SET revoked_at = now()
    WHERE venue_id = ${venueId} AND lower(email) = lower(${email}) AND accepted_at IS NULL AND revoked_at IS NULL`;
}

export async function getVenueInviteByToken(token: string, executor: QueryExecutor = sql) {
  const rows = await executor<InviteRow & { venue_name?: string }>`SELECT * FROM venue_manager_invites
    WHERE token_hash = ${hashInviteToken(token)} LIMIT 1`;
  return rows[0] ? invite(rows[0]) : null;
}

export async function acceptVenueInvite(token: string, userId: string, userEmail: string) {
  return withTransaction(async (tx) => {
    const rows = await tx<InviteRow>`SELECT * FROM venue_manager_invites
      WHERE token_hash = ${hashInviteToken(token)} FOR UPDATE`;
    const row = rows[0];
    if (!row || row.accepted_at || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
    if (row.email.toLowerCase() !== userEmail.toLowerCase()) return { mismatch: true as const, invite: invite(row) };
    await addVenueManager(row.venue_id, userId, row.role, row.invited_by_owner_user_id || userId, tx);
    await tx`UPDATE venue_manager_invites SET accepted_at = now() WHERE id = ${row.id}`;
    return { mismatch: false as const, invite: invite(row) };
  });
}

export async function transferVenueOwner(venueId: number, newOwnerUserId: string) {
  return withTransaction(async (tx) => {
    const owners = await tx<{ id: string; user_id: string }>`SELECT id, user_id FROM venue_claims
      WHERE venue_id = ${venueId} AND status = 'verified' FOR UPDATE`;
    if (!owners[0]) return null;
    if (owners[0].user_id === newOwnerUserId) return owners[0];
    await tx`DELETE FROM venue_managers WHERE venue_id = ${venueId} AND user_id = ${newOwnerUserId}`;
    await tx`UPDATE venue_manager_invites SET revoked_at = now()
      WHERE venue_id = ${venueId} AND accepted_at IS NULL AND revoked_at IS NULL
        AND lower(email) = (SELECT lower(email) FROM users WHERE id = ${newOwnerUserId})`;
    await tx`DELETE FROM venue_claims WHERE venue_id = ${venueId} AND user_id = ${newOwnerUserId} AND id <> ${owners[0].id}`;
    const rows = await tx<{ id: string; user_id: string }>`UPDATE venue_claims SET user_id = ${newOwnerUserId}
      WHERE id = ${owners[0].id} RETURNING id, user_id`;
    return rows[0] ?? null;
  });
}
