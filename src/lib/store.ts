import crypto from 'node:crypto';
import { sql, withTransaction, type QueryExecutor } from './db';
import type { AlertKind } from './validation';

// ---------------------------------------------------------------------------
// Granular Postgres accessors (README-NEON-MIGRATION.md §6 step 6), replacing
// kv.ts's collection-wide read/write-the-whole-array approach. Each function
// here does exactly one row-level operation — no function reads or writes an
// entire table, which is the whole point of this migration (see §1).
//
// Row types (snake_case, matching migrations/0001_init.sql) are mapped to
// domain types (camelCase, matching the shapes the rest of the app already
// expects from the old kv.ts) at the bottom of each section, so call sites
// migrated in Phase 3 see familiar shapes.
// ---------------------------------------------------------------------------

// =============================================================================
// Users
// =============================================================================

export interface User {
  id: string;
  name: string;
  email: string;
  passwordSalt: string | null;
  passwordHash: string | null;
  googleId: string | null;
  picture: string;
  shareId: string;
  phone: string;
  smsConsentAt: string | null;
  weeklyDigestOptIn: boolean;
  accountStatus: 'active' | 'inactive' | 'anonymized';
  deactivatedAt: string | null;
  anonymizedAt: string | null;
  lastActivityAt: string | null;
  locationAnalyticsConsentAt: string | null;
  locationAnalyticsRevokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  password_salt: string | null;
  password_hash: string | null;
  google_id: string | null;
  picture: string;
  share_id: string;
  phone: string;
  sms_consent_at: string | null;
  weekly_digest_opt_in: boolean;
  account_status: 'active' | 'inactive' | 'anonymized';
  deactivated_at: string | null;
  anonymized_at: string | null;
  last_activity_at: string | null;
  location_analytics_consent_at: string | null;
  location_analytics_revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    googleId: row.google_id,
    picture: row.picture,
    shareId: row.share_id,
    phone: row.phone,
    smsConsentAt: row.sms_consent_at,
    weeklyDigestOptIn: row.weekly_digest_opt_in,
    accountStatus: row.account_status,
    deactivatedAt: row.deactivated_at,
    anonymizedAt: row.anonymized_at,
    lastActivityAt: row.last_activity_at,
    locationAnalyticsConsentAt: row.location_analytics_consent_at,
    locationAnalyticsRevokedAt: row.location_analytics_revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getUserById(id: string): Promise<User | null> {
  const rows = await sql<UserRow>`SELECT * FROM users WHERE id = ${id}`;
  return rows[0] ? mapUser(rows[0]) : null;
}

// Case-insensitive on purpose — matches users_email_lower_key. Always pass
// an already-lowercased email; this doesn't lowercase for you so callers
// stay honest about doing it once, at the boundary (see design principle 4).
export async function getUserByEmail(email: string): Promise<User | null> {
  const rows = await sql<UserRow>`SELECT * FROM users WHERE lower(email) = lower(${email})`;
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function getUserByGoogleId(googleId: string): Promise<User | null> {
  const rows = await sql<UserRow>`SELECT * FROM users WHERE google_id = ${googleId}`;
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function getUserByShareId(shareId: string): Promise<User | null> {
  const rows = await sql<UserRow>`SELECT * FROM users WHERE share_id = ${shareId}`;
  return rows[0] ? mapUser(rows[0]) : null;
}

export interface CreateUserInput {
  name: string;
  email: string;
  passwordSalt: string;
  passwordHash: string;
  shareId: string;
}

// No pre-read — let the unique index arbitrate (design principle 5). Callers
// catch the Postgres unique-violation code (23505) and turn it into "An
// account already exists for that email."
export async function createUser(input: CreateUserInput): Promise<User> {
  const rows = await sql<UserRow>`
    INSERT INTO users (name, email, password_salt, password_hash, share_id)
    VALUES (${input.name}, ${input.email}, ${input.passwordSalt}, ${input.passwordHash}, ${input.shareId})
    RETURNING *`;
  return mapUser(rows[0]);
}

export interface UpsertGoogleUserInput {
  email: string;
  googleId: string;
  name: string;
  picture: string;
  shareId: string;
}

// One atomic statement replacing readUsers → find → mutate → writeUsers
// (README-NEON-MIGRATION.md §5, "Google sign-in"). The conflict target is
// the lower(email) expression, matching users_email_lower_key — pass email
// already lowercased.
export async function upsertUserByGoogle(input: UpsertGoogleUserInput): Promise<User> {
  const rows = await sql<UserRow>`
    INSERT INTO users (name, email, google_id, picture, share_id)
    VALUES (${input.name}, ${input.email}, ${input.googleId}, ${input.picture}, ${input.shareId})
    ON CONFLICT (lower(email)) DO UPDATE SET
      google_id = EXCLUDED.google_id,
      name      = COALESCE(NULLIF(EXCLUDED.name, ''), users.name),
      picture   = EXCLUDED.picture
    RETURNING *`;
  return mapUser(rows[0]);
}

export interface UpdateUserProfileInput {
  name?: string;
  passwordSalt?: string;
  passwordHash?: string;
}

export async function updateUserProfile(id: string, input: UpdateUserProfileInput): Promise<User | null> {
  const rows = await sql<UserRow>`
    UPDATE users SET
      name          = COALESCE(${input.name ?? null}, name),
      password_salt = COALESCE(${input.passwordSalt ?? null}, password_salt),
      password_hash = COALESCE(${input.passwordHash ?? null}, password_hash)
    WHERE id = ${id}
    RETURNING *`;
  return rows[0] ? mapUser(rows[0]) : null;
}

export interface UpdateUserPreferencesInput {
  phone: string;
  smsConsentAt: string | null;
  weeklyDigestOptIn: boolean;
}

export async function updateUserPreferences(id: string, input: UpdateUserPreferencesInput): Promise<User | null> {
  const rows = await sql<UserRow>`
    UPDATE users SET
      phone                = ${input.phone},
      sms_consent_at       = ${input.smsConsentAt},
      weekly_digest_opt_in = ${input.weeklyDigestOptIn}
    WHERE id = ${id}
    RETURNING *`;
  return rows[0] ? mapUser(rows[0]) : null;
}

// =============================================================================
// Saved spots
// =============================================================================

export interface SavedSpot {
  spotId: number;
  status: 'favorite' | 'want-to-try' | 'been-to';
  note: string;
  rating?: number;
  createdAt: string;
  updatedAt: string;
}

interface SavedSpotRow {
  venue_id: number;
  status: 'favorite' | 'want-to-try' | 'been-to';
  note: string;
  rating: number | null;
  created_at: string;
  updated_at: string;
}

function mapSavedSpot(row: SavedSpotRow): SavedSpot {
  return {
    spotId: row.venue_id,
    status: row.status,
    note: row.note,
    rating: row.rating ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSavedSpots(userId: string): Promise<SavedSpot[]> {
  const rows = await sql<SavedSpotRow>`
    SELECT venue_id, status, note, rating, created_at, updated_at
    FROM saved_spots WHERE user_id = ${userId} ORDER BY created_at DESC`;
  return rows.map(mapSavedSpot);
}

export interface UpsertSavedSpotInput {
  venueId: number;
  status: 'favorite' | 'want-to-try' | 'been-to';
  note: string;
  rating?: number;
}

// One entry per venue per user, enforced by the UNIQUE (user_id, venue_id)
// constraint — this is the ON CONFLICT upsert from §5 replacing the
// find-or-push loop in the old spots/[id].ts.
export async function upsertSavedSpot(userId: string, input: UpsertSavedSpotInput): Promise<SavedSpot> {
  const rows = await sql<SavedSpotRow>`
    INSERT INTO saved_spots (user_id, venue_id, status, note, rating)
    VALUES (${userId}, ${input.venueId}, ${input.status}, ${input.note}, ${input.rating ?? null})
    ON CONFLICT (user_id, venue_id) DO UPDATE SET
      status = EXCLUDED.status, note = EXCLUDED.note, rating = EXCLUDED.rating
    RETURNING venue_id, status, note, rating, created_at, updated_at`;
  return mapSavedSpot(rows[0]);
}

export async function deleteSavedSpot(userId: string, venueId: number): Promise<void> {
  await sql`DELETE FROM saved_spots WHERE user_id = ${userId} AND venue_id = ${venueId}`;
}

// =============================================================================
// Alerts
// =============================================================================

export interface AlertFilters {
  days: string[];
  neighborhood: string;
  dealType: string;
  feature: string;
  query: string;
}

export interface AlertChannels {
  email: boolean;
  text: boolean;
}

export interface Alert {
  id: string;
  name: string;
  filters: AlertFilters;
  channels: AlertChannels;
  alertKinds: AlertKind[];
  active: boolean;
  sourceAlertId?: string;
  createdAt: string;
  updatedAt: string;
}

export const MAX_ALERTS_PER_USER = 25;

interface AlertRow {
  id: string;
  name: string;
  filters: AlertFilters;
  channel_email: boolean;
  channel_text: boolean;
  alert_kinds: AlertKind[];
  active: boolean;
  source_alert_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    name: row.name,
    filters: row.filters,
    channels: { email: row.channel_email, text: row.channel_text },
    alertKinds: row.alert_kinds,
    active: row.active,
    sourceAlertId: row.source_alert_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAlerts(userId: string): Promise<Alert[]> {
  const rows = await sql<AlertRow>`SELECT * FROM alerts WHERE user_id = ${userId} ORDER BY created_at DESC`;
  return rows.map(mapAlert);
}

export async function getAlert(userId: string, alertId: string): Promise<Alert | null> {
  const rows = await sql<AlertRow>`SELECT * FROM alerts WHERE user_id = ${userId} AND id = ${alertId}`;
  return rows[0] ? mapAlert(rows[0]) : null;
}

export interface CreateAlertInput {
  name: string;
  filters: AlertFilters;
  channels: AlertChannels;
  alertKinds?: AlertKind[];
  sourceAlertId?: string;
}

// Enforces MAX_ALERTS_PER_USER inside the insert itself (§4's "alerts" note)
// rather than a separate count-then-insert, which would race under
// concurrent requests. Returns null when the cap is hit (zero rows back).
export async function createAlert(userId: string, input: CreateAlertInput): Promise<Alert | null> {
  const rows = await sql<AlertRow>`
    INSERT INTO alerts (user_id, name, filters, channel_email, channel_text, alert_kinds, source_alert_id)
    SELECT ${userId}, ${input.name}, ${JSON.stringify(input.filters)}::jsonb, ${input.channels.email}, ${input.channels.text}, ${input.alertKinds ?? ['happy_hour']}::text[], ${input.sourceAlertId ?? null}
    WHERE (SELECT count(*) FROM alerts WHERE user_id = ${userId}) < ${MAX_ALERTS_PER_USER}
    RETURNING *`;
  return rows[0] ? mapAlert(rows[0]) : null;
}

export interface UpdateAlertInput {
  name?: string;
  filters?: AlertFilters;
  channels?: AlertChannels;
  alertKinds?: AlertKind[];
  active?: boolean;
}

// Partial update — only fields present in `input` are touched, matching the
// old kv.ts behavior where the PUT body can send just `{ active }`.
export async function updateAlert(userId: string, alertId: string, input: UpdateAlertInput): Promise<Alert | null> {
  const rows = await sql<AlertRow>`
    UPDATE alerts SET
      name          = COALESCE(${input.name ?? null}, name),
      filters       = COALESCE(${input.filters ? JSON.stringify(input.filters) : null}::jsonb, filters),
      channel_email = COALESCE(${input.channels ? input.channels.email : null}, channel_email),
      channel_text  = COALESCE(${input.channels ? input.channels.text : null}, channel_text),
      alert_kinds   = COALESCE(${input.alertKinds ?? null}::text[], alert_kinds),
      active        = COALESCE(${input.active ?? null}, active)
    WHERE user_id = ${userId} AND id = ${alertId}
    RETURNING *`;
  return rows[0] ? mapAlert(rows[0]) : null;
}

export async function deleteAlert(userId: string, alertId: string): Promise<void> {
  await sql`DELETE FROM alerts WHERE user_id = ${userId} AND id = ${alertId}`;
}

// Used by the clone flow to check "did I already clone this specific shared
// alert" without pulling every alert down first.
export async function hasAlertWithSource(userId: string, sourceAlertId: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }>`
    SELECT EXISTS(SELECT 1 FROM alerts WHERE user_id = ${userId} AND source_alert_id = ${sourceAlertId}) AS exists`;
  return Boolean(rows[0]?.exists);
}

// =============================================================================
// Sessions — replaces Redis TTL (session.ts previously used `{ ex: ... }`).
//
// Single role now (2026-08-12 restaurant sign-in redesign): restaurants
// dropped their own login and their own `restaurant_id` session column —
// see migrations/0002_venue_claims.sql. `role` stays a column (rather than
// being deleted outright) since the CHECK constraint from 0001 still
// permits 'restaurant' as a value; nothing writes it anymore, and every
// session created going forward is 'user'.
// =============================================================================

export type SessionRole = 'user';

export interface SessionRecord {
  id: string;
  role: SessionRole;
  userId: string;
  expiresAt: string;
}

interface SessionRow {
  id: string;
  role: SessionRole;
  user_id: string;
  expires_at: string;
}

function mapSession(row: SessionRow): SessionRecord {
  return { id: row.id, role: row.role, userId: row.user_id, expiresAt: row.expires_at };
}

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours, matches the original

export async function createSession(role: SessionRole, subjectId: string): Promise<SessionRecord> {
  const id = crypto.randomBytes(32).toString('hex');
  const rows = await sql<SessionRow>`
    INSERT INTO sessions (id, role, user_id, expires_at)
    SELECT ${id}, ${role}, id, now() + make_interval(secs => ${SESSION_MAX_AGE_SECONDS})
    FROM users WHERE id = ${subjectId} AND account_status = 'active'
    RETURNING *`;
  if (!rows[0]) throw new RangeError('This account is not active.');
  return mapSession(rows[0]);
}

// Only ever returns unexpired sessions — an expired row is treated the same
// as no row, matching the old TTL behavior where Redis just wouldn't have it.
export async function getSessionById(id: string): Promise<SessionRecord | null> {
  const rows = await sql<SessionRow>`
    SELECT sessions.* FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ${id}
      AND sessions.expires_at > now()
      AND users.account_status = 'active'`;
  return rows[0] ? mapSession(rows[0]) : null;
}

export async function deleteSession(id: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE id = ${id}`;
}

// Opportunistic cleanup — called from the alert-dispatch cron (every 15
// min) rather than on its own schedule, since there's no other recurring
// job to hang it off of and expired rows are otherwise harmless (queries
// already filter on expires_at > now()).
export async function deleteExpiredSessions(): Promise<void> {
  await sql`DELETE FROM sessions WHERE expires_at <= now()`;
}

// =============================================================================
// Venue claims — replaces the old separate `restaurants` account (see the
// 2026-08-12 restaurant sign-in redesign). Restaurants no longer have their
// own login; a "claim" is a (user_id, venue_id) record attached to a regular
// user's account, so the same person can manage multiple venues, and
// verification is scoped to the specific venue being claimed rather than
// self-reported at signup and never checked again.
// =============================================================================

export interface VenueClaim {
  id: string;
  userId: string;
  venueId: number;
  status: 'verified' | 'pending' | 'denied';
  verificationMethod: 'domain' | 'phone' | 'manual' | null;
  phone: string;
  phoneVerifiedAt: string | null;
  claimNote: string;
  denialReason?: string;
  plan: 'free' | 'paid';
  smsFundingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VenueClaimRow {
  id: string;
  user_id: string;
  venue_id: number;
  status: 'verified' | 'pending' | 'denied';
  verification_method: 'domain' | 'phone' | 'manual' | null;
  phone: string;
  phone_verified_at: string | null;
  claim_note: string;
  denial_reason: string | null;
  plan: 'free' | 'paid';
  sms_funding_enabled: boolean;
  created_at: string;
  updated_at: string;
}

function mapVenueClaim(row: VenueClaimRow): VenueClaim {
  return {
    id: row.id,
    userId: row.user_id,
    venueId: row.venue_id,
    status: row.status,
    verificationMethod: row.verification_method,
    phone: row.phone,
    phoneVerifiedAt: row.phone_verified_at,
    claimNote: row.claim_note,
    denialReason: row.denial_reason ?? undefined,
    plan: row.plan,
    smsFundingEnabled: row.sms_funding_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getVenueClaimById(id: string): Promise<VenueClaim | null> {
  const rows = await sql<VenueClaimRow>`SELECT * FROM venue_claims WHERE id = ${id}`;
  return rows[0] ? mapVenueClaim(rows[0]) : null;
}

export async function getVenueClaimByUserAndVenue(userId: string, venueId: number): Promise<VenueClaim | null> {
  const rows = await sql<VenueClaimRow>`SELECT * FROM venue_claims WHERE user_id = ${userId} AND venue_id = ${venueId}`;
  return rows[0] ? mapVenueClaim(rows[0]) : null;
}

// A user can hold claims on more than one venue (a small restaurant group,
// or someone who runs two spots) — the old one-restaurant-per-account model
// couldn't express that at all.
export async function listVenueClaimsByUser(userId: string): Promise<VenueClaim[]> {
  const rows = await sql<VenueClaimRow>`SELECT * FROM venue_claims WHERE user_id = ${userId} ORDER BY created_at DESC`;
  return rows.map(mapVenueClaim);
}

// Admin review queue — every claim regardless of status, same as the old
// listRestaurants() (the admin UI sorts pending-first client-side).
export async function listVenueClaims(): Promise<VenueClaim[]> {
  const rows = await sql<VenueClaimRow>`SELECT * FROM venue_claims ORDER BY created_at DESC`;
  return rows.map(mapVenueClaim);
}

// All venue_ids that currently have a verified claimant — small table,
// cheap to fetch whole (mirrors getLiveOverrides()'s pattern). Used by the
// venue search UI so it can show "already claimed" instead of letting
// someone waste a claim attempt on a venue someone else already verified.
export async function listVerifiedClaimedVenueIds(): Promise<Set<number>> {
  const rows = await sql<{ venue_id: number }>`SELECT venue_id FROM venue_claims WHERE status = 'verified'`;
  return new Set(rows.map((r) => r.venue_id));
}

export interface CreateVenueClaimInput {
  userId: string;
  venueId: number;
  status: 'verified' | 'pending' | 'denied';
  verificationMethod: 'domain' | 'phone' | 'manual' | null;
  claimNote?: string;
}

// One row per (user, venue) — UNIQUE (user_id, venue_id) means a second
// claim attempt on the same venue by the same user should go through
// updateVenueClaim instead (callers check getVenueClaimByUserAndVenue first
// and update-or-create accordingly, matching how a denied claim gets
// resubmitted rather than duplicated).
export async function createVenueClaim(input: CreateVenueClaimInput): Promise<VenueClaim> {
  const rows = await sql<VenueClaimRow>`
    INSERT INTO venue_claims (user_id, venue_id, status, verification_method, claim_note)
    VALUES (${input.userId}, ${input.venueId}, ${input.status}, ${input.verificationMethod}, ${input.claimNote ?? ''})
    RETURNING *`;
  return mapVenueClaim(rows[0]);
}

export interface UpdateVenueClaimInput {
  status?: 'verified' | 'pending' | 'denied';
  verificationMethod?: 'domain' | 'phone' | 'manual' | null;
  claimNote?: string;
  denialReason?: string | null;
}

// Throws (Postgres unique-violation 23505) if this would create a second
// *verified* claim on a venue that already has one — callers catch that and
// surface "This venue has already been claimed by another account."
export async function updateVenueClaim(id: string, input: UpdateVenueClaimInput): Promise<VenueClaim | null> {
  const rows = await sql<VenueClaimRow>`
    UPDATE venue_claims SET
      status               = COALESCE(${input.status ?? null}, status),
      verification_method  = CASE WHEN ${input.verificationMethod !== undefined} THEN ${input.verificationMethod ?? null} ELSE verification_method END,
      claim_note           = COALESCE(${input.claimNote ?? null}, claim_note),
      denial_reason        = CASE WHEN ${input.denialReason !== undefined} THEN ${input.denialReason ?? null} ELSE denial_reason END
    WHERE id = ${id}
    RETURNING *`;
  return rows[0] ? mapVenueClaim(rows[0]) : null;
}

// Sends a fresh code (stores it — the actual SMS send happens in the API
// route via lib/sms.ts, using the venue's own listed phone number from
// venues.ts, never a claimant-supplied one — that's the whole point of
// phone verification over a self-reported claim). `phone` here is a
// snapshot of the number the code was actually sent to, kept for admin
// visibility even though it's derivable from venue data at the time.
export async function setVenueClaimPhoneCode(claimId: string, code: string, expiresAt: string, phone: string): Promise<VenueClaim | null> {
  const rows = await sql<VenueClaimRow>`
    UPDATE venue_claims SET
      phone = ${phone},
      phone_code = ${code},
      phone_code_expires_at = ${expiresAt},
      verification_method = 'phone'
    WHERE id = ${claimId}
    RETURNING *`;
  return rows[0] ? mapVenueClaim(rows[0]) : null;
}

// Verifies the code in one atomic UPDATE (no separate read-then-check —
// avoids a race where two requests both read a valid code before either
// clears it). Matches only if the code is right AND unexpired; the code is
// single-use, cleared on success either way. Returns null on any mismatch
// (wrong code, expired, or claim doesn't exist) — callers can't distinguish
// "wrong code" from "expired" from this alone, which is deliberate: no
// reason to tell an attacker which one it was.
//
// Throws (Postgres unique-violation 23505) if this would create a second
// *verified* claim on a venue that already has one, same as updateVenueClaim.
export async function verifyVenueClaimPhoneCode(claimId: string, code: string): Promise<VenueClaim | null> {
  const rows = await sql<VenueClaimRow>`
    UPDATE venue_claims SET
      status = 'verified',
      phone_code = NULL,
      phone_code_expires_at = NULL,
      phone_verified_at = now()
    WHERE id = ${claimId} AND phone_code = ${code} AND phone_code_expires_at > now()
    RETURNING *`;
  return rows[0] ? mapVenueClaim(rows[0]) : null;
}

// =============================================================================
// Submissions
// =============================================================================

export interface Listing {
  name: string;
  neighborhood: string;
  address: string;
  lat: number | null;
  lng: number | null;
  days: string[];
  openTime?: string;
  closeTime?: string;
  startTime: string;
  endTime: string;
  deals: string[];
  vibe: string;
  website: string;
  verified: boolean;
  lastVerifiedAt: string | null;
  sourceUrl: string;
  dealTypes: string[];
  features: string[];
  // Optional — not required at submission time (many submitters won't have
  // it handy), but worth capturing since it's what backs phone-based claim
  // verification (see venues.ts's Venue.phone).
  phone?: string;
  // Featured photo for the listing, set by an admin in the review queue or
  // the venue editor — normally `/api/images/<key>`, our own stored copy
  // (lib/imageStore.ts). Absent/empty means the public pages fall back to the
  // vibe stock photo, which is what every venue did before this existed.
  image?: string;
}

export interface Submission {
  id: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  updatedAt: string;
  contact: { contactName: string; contactEmail: string; notes: string };
  listing: Listing;
  denialReason?: string;
  approvedListingId?: number;
}

interface SubmissionRow {
  id: string;
  status: 'pending' | 'approved' | 'denied';
  contact_name: string;
  contact_email: string;
  contact_notes: string;
  listing: Listing;
  denial_reason: string | null;
  approved_listing_id: number | null;
  created_at: string;
  updated_at: string;
}

function mapSubmission(row: SubmissionRow): Submission {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contact: { contactName: row.contact_name, contactEmail: row.contact_email, notes: row.contact_notes },
    listing: row.listing,
    denialReason: row.denial_reason ?? undefined,
    approvedListingId: row.approved_listing_id ?? undefined,
  };
}

export async function listSubmissions(): Promise<Submission[]> {
  const rows = await sql<SubmissionRow>`SELECT * FROM submissions ORDER BY created_at DESC`;
  return rows.map(mapSubmission);
}

export async function getSubmission(id: string): Promise<Submission | null> {
  const rows = await sql<SubmissionRow>`SELECT * FROM submissions WHERE id = ${id}`;
  return rows[0] ? mapSubmission(rows[0]) : null;
}

export interface CreateSubmissionInput {
  contact: { contactName: string; contactEmail: string; notes: string };
  listing: Listing;
}

export async function createSubmission(input: CreateSubmissionInput): Promise<Submission> {
  const rows = await sql<SubmissionRow>`
    INSERT INTO submissions (contact_name, contact_email, contact_notes, listing)
    VALUES (${input.contact.contactName}, ${input.contact.contactEmail}, ${input.contact.notes}, ${JSON.stringify(input.listing)}::jsonb)
    RETURNING *`;
  return mapSubmission(rows[0]);
}

export interface UpdateSubmissionInput {
  status?: 'pending' | 'approved' | 'denied';
  listing?: Listing;
  denialReason?: string;
  approvedListingId?: number;
}

export async function updateSubmission(id: string, input: UpdateSubmissionInput): Promise<Submission | null> {
  const rows = await sql<SubmissionRow>`
    UPDATE submissions SET
      status               = COALESCE(${input.status ?? null}, status),
      listing               = COALESCE(${input.listing ? JSON.stringify(input.listing) : null}::jsonb, listing),
      denial_reason         = COALESCE(${input.denialReason ?? null}, denial_reason),
      approved_listing_id   = COALESCE(${input.approvedListingId ?? null}, approved_listing_id)
    WHERE id = ${id}
    RETURNING *`;
  return rows[0] ? mapSubmission(rows[0]) : null;
}

// =============================================================================
// Live overrides — keyed by venue_id (see §4).
// =============================================================================

export interface LiveOverride {
  active: boolean;
  since: string;
  expiresAt: string;
}

interface LiveOverrideRow {
  venue_id: number;
  active: boolean;
  since: string;
  expires_at: string;
}

// Only active, unexpired rows — callers never have to check expiresAt
// themselves (matches the old readLiveOverrides()'s filtered-in-caller
// behavior, but now filtered in the query).
export async function getLiveOverrides(): Promise<Record<number, LiveOverride>> {
  const rows = await sql<LiveOverrideRow>`
    SELECT venue_id, active, since, expires_at FROM live_overrides
    WHERE active AND expires_at > now()`;
  const result: Record<number, LiveOverride> = {};
  for (const row of rows) {
    result[row.venue_id] = { active: row.active, since: row.since, expiresAt: row.expires_at };
  }
  return result;
}

export async function setLiveOverride(venueId: number, override: { since: string; expiresAt: string } | null): Promise<void> {
  if (!override) {
    await sql`DELETE FROM live_overrides WHERE venue_id = ${venueId}`;
    return;
  }
  await sql`
    INSERT INTO live_overrides (venue_id, active, since, expires_at)
    VALUES (${venueId}, true, ${override.since}, ${override.expiresAt})
    ON CONFLICT (venue_id) DO UPDATE SET
      active = true, since = EXCLUDED.since, expires_at = EXCLUDED.expires_at`;
}

// =============================================================================
// Promotions — keyed by venue_id (see §4).
// =============================================================================

export interface Promotion {
  dealCode: string;
  description: string;
  updatedAt: string;
}

interface PromotionRow {
  venue_id: number;
  deal_code: string;
  description: string;
  updated_at: string;
}

export async function getPromotions(): Promise<Record<number, Promotion>> {
  const rows = await sql<PromotionRow>`SELECT * FROM promotions`;
  const result: Record<number, Promotion> = {};
  for (const row of rows) {
    result[row.venue_id] = { dealCode: row.deal_code, description: row.description, updatedAt: row.updated_at };
  }
  return result;
}

export async function getPromotion(venueId: number): Promise<Promotion | null> {
  const rows = await sql<PromotionRow>`SELECT * FROM promotions WHERE venue_id = ${venueId}`;
  return rows[0] ? { dealCode: rows[0].deal_code, description: rows[0].description, updatedAt: rows[0].updated_at } : null;
}

export async function setPromotion(venueId: number, input: { dealCode: string; description: string }): Promise<Promotion> {
  const rows = await sql<PromotionRow>`
    INSERT INTO promotions (venue_id, deal_code, description)
    VALUES (${venueId}, ${input.dealCode}, ${input.description})
    ON CONFLICT (venue_id) DO UPDATE SET deal_code = EXCLUDED.deal_code, description = EXCLUDED.description
    RETURNING *`;
  return { dealCode: rows[0].deal_code, description: rows[0].description, updatedAt: rows[0].updated_at };
}

export async function deletePromotion(venueId: number): Promise<void> {
  await sql`DELETE FROM promotions WHERE venue_id = ${venueId}`;
}

// =============================================================================
// Notification log — backs dedup + the per-user daily SMS cap (see §5).
// =============================================================================

export interface NotificationLogEntry {
  userId: string;
  venueId: number;
  channel: 'email' | 'text';
  notificationKind: 'happy_hour' | 'promotion';
  eventKey: string | null;
  sentAt: string;
}

interface NotificationLogRow {
  user_id: string;
  venue_id: number;
  channel: 'email' | 'text';
  notification_kind: 'happy_hour' | 'promotion';
  event_key: string | null;
  sent_at: string;
}

function mapNotification(row: NotificationLogRow): NotificationLogEntry {
  return {
    userId: row.user_id,
    venueId: row.venue_id,
    channel: row.channel,
    notificationKind: row.notification_kind,
    eventKey: row.event_key,
    sentAt: row.sent_at,
  };
}

// Everything at or after `sinceIso` — the dispatch job passes the earlier of
// its cooldown cutoff and its daily-cap day-start so one query covers both
// (see notify.ts).
export async function listNotificationsSince(sinceIso: string): Promise<NotificationLogEntry[]> {
  const rows = await sql<NotificationLogRow>`
    SELECT user_id, venue_id, channel, notification_kind, event_key, sent_at
    FROM notification_log WHERE sent_at >= ${sinceIso}`;
  return rows.map(mapNotification);
}

export async function listNotificationsForEventKeys(eventKeys: string[]): Promise<NotificationLogEntry[]> {
  if (!eventKeys.length) return [];
  const rows = await sql<NotificationLogRow>`
    SELECT user_id, venue_id, channel, notification_kind, event_key, sent_at
    FROM notification_log
    WHERE notification_kind = 'promotion' AND event_key = ANY(${eventKeys}::text[])`;
  return rows.map(mapNotification);
}

export async function insertNotifications(entries: NotificationLogEntry[]): Promise<void> {
  if (!entries.length) return;
  await withTransaction(async (txSql) => {
    for (const entry of entries) {
      await txSql`
        INSERT INTO notification_log (
          user_id, venue_id, channel, notification_kind, event_key, sent_at
        ) VALUES (
          ${entry.userId}, ${entry.venueId}, ${entry.channel},
          ${entry.notificationKind}, ${entry.eventKey}, ${entry.sentAt}
        )`;
    }
  });
}

// Retention moved into SQL (§4) instead of a rewrite-the-whole-array prune.
export async function pruneNotificationLog(retentionDays = 7): Promise<void> {
  await sql`DELETE FROM notification_log WHERE sent_at < now() - make_interval(days => ${retentionDays})`;
}

// =============================================================================
// Alert dispatch query (§5, "Alert dispatch" — the big one)
// =============================================================================

export interface ActiveAlertForDispatch {
  alertId: string;
  filters: AlertFilters;
  channelEmail: boolean;
  channelText: boolean;
  userId: string;
  userName: string;
  userEmail: string;
  userPhone: string;
  userSmsConsentAt: string | null;
}

interface ActiveAlertDispatchRow {
  alert_id: string;
  filters: AlertFilters;
  channel_email: boolean;
  channel_text: boolean;
  user_id: string;
  user_name: string;
  user_email: string;
  user_phone: string;
  user_sms_consent_at: string | null;
}

// Fetches only alerts that could plausibly fire, instead of every user and
// all their data (README-NEON-MIGRATION.md §5's "the big one" — this is
// what stops the cron's bandwidth from scaling with total signups). Venue
// matching still happens in application code (notify.ts), since venues live
// in JSON, not the database — see §5's "honest limitation" and §7.
export async function listActiveAlertsForDispatch(): Promise<ActiveAlertForDispatch[]> {
  const rows = await sql<ActiveAlertDispatchRow>`
    SELECT a.id AS alert_id, a.filters, a.channel_email, a.channel_text,
           u.id AS user_id, u.name AS user_name, u.email AS user_email,
           u.phone AS user_phone, u.sms_consent_at AS user_sms_consent_at
    FROM alerts a
    JOIN users u ON u.id = a.user_id
    WHERE a.active
      AND 'happy_hour' = ANY(a.alert_kinds)
      AND (a.channel_email OR (a.channel_text AND u.sms_consent_at IS NOT NULL))`;
  return rows.map((row) => ({
    alertId: row.alert_id,
    filters: row.filters,
    channelEmail: row.channel_email,
    channelText: row.channel_text,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    userPhone: row.user_phone,
    userSmsConsentAt: row.user_sms_consent_at,
  }));
}

// =============================================================================
// Images
// =============================================================================

// Metadata for what's in Netlify Blobs — the bytes themselves live there, not
// here (see migrations/0003_images.sql for why). Recording is best-effort at
// the call sites: the blob write has already succeeded by the time these run,
// so a database hiccup shouldn't fail an upload the user can see worked.

export interface ImageRecord {
  key: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  // 'owner' is a restaurant owner's upload through the dashboard, as opposed
  // to the four admin-screen origins — the one kind of image that was never
  // looked at by a human before being stored (migrations/0004).
  origin: 'upload' | 'url' | 'generated' | 'edited' | 'owner';
  sourceUrl: string | null;
  prompt: string | null;
  slugHint: string;
  createdBy: string;
  createdAt: string;
}

interface ImageRow {
  key: string;
  content_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  origin: ImageRecord['origin'];
  source_url: string | null;
  prompt: string | null;
  slug_hint: string;
  created_by: string;
  created_at: string;
}

function mapImage(row: ImageRow): ImageRecord {
  return {
    key: row.key,
    contentType: row.content_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    origin: row.origin,
    sourceUrl: row.source_url,
    prompt: row.prompt,
    slugHint: row.slug_hint,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export interface RecordImageInput {
  key: string;
  contentType: string;
  byteSize: number;
  width?: number | null;
  height?: number | null;
  origin: ImageRecord['origin'];
  sourceUrl?: string | null;
  prompt?: string | null;
  slugHint?: string;
  createdBy?: string;
}

// Keys come from makeImageKey(), which is collision-resistant, so a conflict
// here means the same upload got recorded twice rather than two different
// images colliding — hence DO NOTHING rather than an error.
export async function recordImage(input: RecordImageInput): Promise<ImageRecord | null> {
  const rows = await sql<ImageRow>`
    INSERT INTO images (
      key, content_type, byte_size, width, height,
      origin, source_url, prompt, slug_hint, created_by
    )
    VALUES (
      ${input.key}, ${input.contentType}, ${input.byteSize},
      ${input.width ?? null}, ${input.height ?? null},
      ${input.origin}, ${input.sourceUrl ?? null}, ${input.prompt ?? null},
      ${input.slugHint ?? ''}, ${input.createdBy ?? ''}
    )
    ON CONFLICT (key) DO NOTHING
    RETURNING *`;
  return rows[0] ? mapImage(rows[0]) : null;
}

export async function getImage(key: string): Promise<ImageRecord | null> {
  const rows = await sql<ImageRow>`SELECT * FROM images WHERE key = ${key}`;
  return rows[0] ? mapImage(rows[0]) : null;
}

export async function listImages(limit = 200): Promise<ImageRecord[]> {
  const rows = await sql<ImageRow>`
    SELECT * FROM images ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(mapImage);
}

export async function deleteImageRecord(key: string): Promise<boolean> {
  const rows = await sql<{ key: string }>`
    DELETE FROM images WHERE key = ${key} RETURNING key`;
  return rows.length > 0;
}

export type { QueryExecutor };

// ---------------------------------------------------------------------------
// Owner-managed venue content (migrations/0004_venue_content.sql)
//
// Everything below backs the restaurant dashboard's management screens. It is
// deliberately separate from happy-hours.json: that file is the admin-curated
// base record, committed to the repo and only live after a deploy, whereas an
// owner fixing their hours or adding a photo has to take effect immediately.
// src/lib/venueContent.ts is where the two get merged.
// ---------------------------------------------------------------------------

/** Runtime listing edits as a partial patch over the happy-hours.json row.
 * Usually written by a verified claimant; admins also merge field-level
 * corrections here when those fields must go live before the next deploy.
 * Only OWNER_EDITABLE_FIELDS (venueContent.ts) are stored. */
export interface VenueOverride {
  venueId: number;
  patch: Record<string, unknown>;
  updatedBy: string;
  updatedAt: string;
}

interface VenueOverrideRow {
  venue_id: number;
  patch: Record<string, unknown>;
  updated_by: string;
  updated_at: string;
}

function mapVenueOverride(row: VenueOverrideRow): VenueOverride {
  return {
    venueId: row.venue_id,
    patch: row.patch || {},
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export async function getVenueOverride(venueId: number): Promise<VenueOverride | null> {
  const rows = await sql<VenueOverrideRow>`SELECT * FROM venue_overrides WHERE venue_id = ${venueId}`;
  return rows[0] ? mapVenueOverride(rows[0]) : null;
}

/** Every override, keyed by venue id — one query for the homepage/list pages,
 * which need to merge overrides across every venue at once. */
export async function getVenueOverrides(): Promise<Record<number, VenueOverride>> {
  const rows = await sql<VenueOverrideRow>`SELECT * FROM venue_overrides`;
  const byVenue: Record<number, VenueOverride> = {};
  for (const row of rows) byVenue[row.venue_id] = mapVenueOverride(row);
  return byVenue;
}

/** Replaces the whole patch rather than merging into the stored one: the
 * dashboard always submits the complete set of owner-editable fields, so a
 * merge would make it impossible to clear a field back to the base value. */
export async function setVenueOverride(
  venueId: number,
  patch: Record<string, unknown>,
  updatedBy: string
): Promise<VenueOverride> {
  const rows = await sql<VenueOverrideRow>`
    INSERT INTO venue_overrides (venue_id, patch, updated_by)
    VALUES (${venueId}, ${JSON.stringify(patch)}::jsonb, ${updatedBy})
    ON CONFLICT (venue_id) DO UPDATE
      SET patch = ${JSON.stringify(patch)}::jsonb,
          updated_by = ${updatedBy},
          updated_at = now()
    RETURNING *`;
  return mapVenueOverride(rows[0]);
}

/** Atomically merges a field-level admin correction into the current live
 * patch. Unlike the owner dashboard's complete replacement above, an admin
 * editor may have been open while the owner saved newer hours or deals. A
 * JSONB merge means changing only `image` cannot revert those concurrent
 * owner fields between the route's read and write. */
export async function mergeVenueOverride(
  venueId: number,
  patchDelta: Record<string, unknown>,
  updatedBy: string
): Promise<VenueOverride> {
  const rows = await sql<VenueOverrideRow>`
    INSERT INTO venue_overrides (venue_id, patch, updated_by)
    VALUES (${venueId}, ${JSON.stringify(patchDelta)}::jsonb, ${updatedBy})
    ON CONFLICT (venue_id) DO UPDATE
      SET patch = venue_overrides.patch || EXCLUDED.patch,
          updated_by = ${updatedBy},
          updated_at = now()
    RETURNING *`;
  return mapVenueOverride(rows[0]);
}

/** A photo in a venue's album. Also the moderation record for that photo:
 * menu item photos point at one of these rather than at a raw image key, so
 * one screening decision governs everywhere the photo is shown. */
export interface VenuePhoto {
  id: string;
  venueId: number;
  imageKey: string;
  caption: string;
  status: 'published' | 'in_review' | 'rejected';
  photoType: 'venue' | 'menu_item';
  /** Verbatim result of the automated screen, or null if it never ran. */
  moderation: Record<string, unknown> | null;
  reviewNote: string;
  reviewedBy: string;
  reviewedAt: string | null;
  sortOrder: number;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface VenuePhotoRow {
  id: string;
  venue_id: number;
  image_key: string;
  caption: string;
  status: VenuePhoto['status'];
  photo_type: VenuePhoto['photoType'];
  moderation: Record<string, unknown> | null;
  review_note: string;
  reviewed_by: string;
  reviewed_at: string | null;
  sort_order: number;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
}

function mapVenuePhoto(row: VenuePhotoRow): VenuePhoto {
  return {
    id: row.id,
    venueId: row.venue_id,
    imageKey: row.image_key,
    caption: row.caption,
    status: row.status,
    photoType: row.photo_type,
    moderation: row.moderation,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    sortOrder: row.sort_order,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** All published photos for a venue (both gallery and menu item photos). */
export async function listPublishedVenuePhotos(venueId: number): Promise<VenuePhoto[]> {
  const rows = await sql<VenuePhotoRow>`
    SELECT * FROM venue_photos
    WHERE venue_id = ${venueId} AND status = 'published'
    ORDER BY sort_order, created_at`;
  return rows.map(mapVenuePhoto);
}

/** Just the venue gallery photos (for the public album/modal), excluding menu item photos. */
export async function listPublishedVenueGalleryPhotos(venueId: number): Promise<VenuePhoto[]> {
  const rows = await sql<VenuePhotoRow>`
    SELECT * FROM venue_photos
    WHERE venue_id = ${venueId} AND status = 'published' AND photo_type = 'venue'
    ORDER BY sort_order, created_at`;
  return rows.map(mapVenuePhoto);
}

/** Everything the owner has uploaded for this venue, including photos still in
 * review or rejected — they need to see why something isn't showing. */
export async function listVenuePhotos(venueId: number): Promise<VenuePhoto[]> {
  const rows = await sql<VenuePhotoRow>`
    SELECT * FROM venue_photos
    WHERE venue_id = ${venueId} AND status <> 'rejected'
    ORDER BY sort_order, created_at`;
  return rows.map(mapVenuePhoto);
}

/** Includes rejected ones — the owner-facing list, so a rejection and its
 * reason are visible rather than the photo silently vanishing. */
export async function listVenuePhotosForOwner(venueId: number): Promise<VenuePhoto[]> {
  const rows = await sql<VenuePhotoRow>`
    SELECT * FROM venue_photos
    WHERE venue_id = ${venueId}
    ORDER BY sort_order, created_at`;
  return rows.map(mapVenuePhoto);
}

export async function getVenuePhoto(id: string): Promise<VenuePhoto | null> {
  const rows = await sql<VenuePhotoRow>`SELECT * FROM venue_photos WHERE id = ${id}`;
  return rows[0] ? mapVenuePhoto(rows[0]) : null;
}

/** The admin moderation queue: everything held for review, oldest first, so
 * the owner who has been waiting longest gets looked at first. */
export async function listVenuePhotosForReview(limit = 200): Promise<VenuePhoto[]> {
  const rows = await sql<VenuePhotoRow>`
    SELECT * FROM venue_photos
    WHERE status = 'in_review'
    ORDER BY created_at
    LIMIT ${limit}`;
  return rows.map(mapVenuePhoto);
}

/** Publish legacy photos left waiting by the former manual-review workflow. */
export async function publishVenuePhotosAwaitingReview(venueId: number): Promise<void> {
  await sql`
    UPDATE venue_photos
    SET status = 'published', updated_at = now()
    WHERE venue_id = ${venueId} AND status = 'in_review'`;
}

/** How many photos this venue has that aren't rejected — what the per-venue
 * upload cap is enforced against. */
export async function countVenuePhotos(venueId: number): Promise<number> {
  const rows = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM venue_photos
    WHERE venue_id = ${venueId} AND status <> 'rejected'`;
  return Number(rows[0]?.count || 0);
}

export interface CreateVenuePhotoInput {
  venueId: number;
  imageKey: string;
  caption?: string;
  status: VenuePhoto['status'];
  photoType?: VenuePhoto['photoType'];
  moderation?: Record<string, unknown> | null;
  uploadedBy: string;
}

export async function createVenuePhoto(input: CreateVenuePhotoInput): Promise<VenuePhoto> {
  // New photos land at the end of the album: one past the current highest
  // sort_order rather than 0, so an upload doesn't jump ahead of photos the
  // owner has already arranged.
  const rows = await sql<VenuePhotoRow>`
    INSERT INTO venue_photos (venue_id, image_key, caption, status, photo_type, moderation, uploaded_by, sort_order)
    VALUES (
      ${input.venueId}, ${input.imageKey}, ${input.caption ?? ''}, ${input.status},
      ${input.photoType ?? 'venue'},
      ${input.moderation ? JSON.stringify(input.moderation) : null}::jsonb,
      ${input.uploadedBy},
      COALESCE((SELECT max(sort_order) + 1 FROM venue_photos WHERE venue_id = ${input.venueId}), 0)
    )
    RETURNING *`;
  return mapVenuePhoto(rows[0]);
}

export interface UpdateVenuePhotoInput {
  caption?: string;
  status?: VenuePhoto['status'];
  sortOrder?: number;
  reviewNote?: string;
  reviewedBy?: string;
  /** Set alongside reviewedBy when an admin decides; left alone otherwise. */
  markReviewed?: boolean;
}

export async function updateVenuePhoto(id: string, input: UpdateVenuePhotoInput): Promise<VenuePhoto | null> {
  const rows = await sql<VenuePhotoRow>`
    UPDATE venue_photos SET
      caption     = COALESCE(${input.caption ?? null}, caption),
      status      = COALESCE(${input.status ?? null}, status),
      sort_order  = COALESCE(${input.sortOrder ?? null}, sort_order),
      review_note = COALESCE(${input.reviewNote ?? null}, review_note),
      reviewed_by = COALESCE(${input.reviewedBy ?? null}, reviewed_by),
      reviewed_at = CASE WHEN ${input.markReviewed ?? false} THEN now() ELSE reviewed_at END,
      updated_at  = now()
    WHERE id = ${id}
    RETURNING *`;
  return rows[0] ? mapVenuePhoto(rows[0]) : null;
}

/** Removes the album row. The blob and its `images` record are left alone:
 * they're the evidence of what was uploaded, and menu items referencing this
 * photo are set to null by the FK rather than breaking. */
export async function deleteVenuePhoto(id: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`DELETE FROM venue_photos WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

/** A menu section plus its items, which is the only shape either the public
 * venue page or the dashboard ever wants. */
export interface MenuSection {
  id: string;
  venueId: number;
  title: string;
  note: string;
  sortOrder: number;
  items: MenuItem[];
}

export interface MenuItem {
  id: string;
  sectionId: string;
  name: string;
  price: string;
  description: string;
  /** venue_photos.id, so the item's photo carries the same moderation status
   * as an album photo. Null when the owner hasn't attached one. */
  photoId: string | null;
  /** Whether this item's photo should also be included in the venue hero
   * gallery. Kept on the item (rather than the photo) so the same approved
   * photo can be reused by multiple menu items without one item unexpectedly
   * changing another item's presentation. */
  showPhotoInGallery: boolean;
  sortOrder: number;
}

interface MenuSectionRow {
  id: string;
  venue_id: number;
  title: string;
  note: string;
  sort_order: number;
}

interface MenuItemRow {
  id: string;
  section_id: string;
  name: string;
  price: string;
  description: string;
  photo_id: string | null;
  show_photo_in_gallery: boolean;
  sort_order: number;
}

function mapMenuItem(row: MenuItemRow): MenuItem {
  return {
    id: row.id,
    sectionId: row.section_id,
    name: row.name,
    price: row.price,
    description: row.description,
    photoId: row.photo_id,
    showPhotoInGallery: row.show_photo_in_gallery,
    sortOrder: row.sort_order,
  };
}

/** The whole menu for a venue, sections in order with their items in order.
 * Two queries rather than a join so an empty section doesn't need
 * null-row handling, and the item mapping stays trivial. */
export async function getVenueMenu(venueId: number): Promise<MenuSection[]> {
  const sectionRows = await sql<MenuSectionRow>`
    SELECT * FROM menu_sections WHERE venue_id = ${venueId} ORDER BY sort_order, created_at`;
  if (!sectionRows.length) return [];

  const itemRows = await sql<MenuItemRow>`
    SELECT i.* FROM menu_items i
    JOIN menu_sections s ON s.id = i.section_id
    WHERE s.venue_id = ${venueId}
    ORDER BY i.sort_order, i.created_at`;

  return sectionRows.map((section) => ({
    id: section.id,
    venueId: section.venue_id,
    title: section.title,
    note: section.note,
    sortOrder: section.sort_order,
    items: itemRows.filter((item) => item.section_id === section.id).map(mapMenuItem),
  }));
}

/** Which venue a section belongs to — the ownership check every mutating
 * menu route runs before touching it. */
export async function getMenuSection(id: string): Promise<{ id: string; venueId: number } | null> {
  const rows = await sql<{ id: string; venue_id: number }>`
    SELECT id, venue_id FROM menu_sections WHERE id = ${id}`;
  return rows[0] ? { id: rows[0].id, venueId: rows[0].venue_id } : null;
}

/** Same, for an item — resolved through its section, since items have no
 * venue_id of their own. */
export async function getMenuItemVenue(id: string): Promise<{ id: string; venueId: number } | null> {
  const rows = await sql<{ id: string; venue_id: number }>`
    SELECT i.id, s.venue_id FROM menu_items i
    JOIN menu_sections s ON s.id = i.section_id
    WHERE i.id = ${id}`;
  return rows[0] ? { id: rows[0].id, venueId: rows[0].venue_id } : null;
}

export async function countMenuSections(venueId: number): Promise<number> {
  const rows = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM menu_sections WHERE venue_id = ${venueId}`;
  return Number(rows[0]?.count || 0);
}

export async function countMenuItems(sectionId: string): Promise<number> {
  const rows = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM menu_items WHERE section_id = ${sectionId}`;
  return Number(rows[0]?.count || 0);
}

export async function createMenuSection(venueId: number, title: string, note = ''): Promise<MenuSection> {
  const rows = await sql<MenuSectionRow>`
    INSERT INTO menu_sections (venue_id, title, note, sort_order)
    VALUES (
      ${venueId}, ${title}, ${note},
      COALESCE((SELECT max(sort_order) + 1 FROM menu_sections WHERE venue_id = ${venueId}), 0)
    )
    RETURNING *`;
  const row = rows[0];
  return { id: row.id, venueId: row.venue_id, title: row.title, note: row.note, sortOrder: row.sort_order, items: [] };
}

export interface UpdateMenuSectionInput {
  title?: string;
  note?: string;
  sortOrder?: number;
}

export async function updateMenuSection(id: string, input: UpdateMenuSectionInput): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    UPDATE menu_sections SET
      title      = COALESCE(${input.title ?? null}, title),
      note       = COALESCE(${input.note ?? null}, note),
      sort_order = COALESCE(${input.sortOrder ?? null}, sort_order),
      updated_at = now()
    WHERE id = ${id}
    RETURNING id`;
  return rows.length > 0;
}

/** Items go with it — ON DELETE CASCADE on menu_items.section_id. */
export async function deleteMenuSection(id: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`DELETE FROM menu_sections WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export interface CreateMenuItemInput {
  sectionId: string;
  name: string;
  price?: string;
  description?: string;
  photoId?: string | null;
  showPhotoInGallery?: boolean;
}

export async function createMenuItem(input: CreateMenuItemInput): Promise<MenuItem> {
  const rows = await sql<MenuItemRow>`
    INSERT INTO menu_items (
      section_id, name, price, description, photo_id, show_photo_in_gallery, sort_order
    )
    VALUES (
      ${input.sectionId}, ${input.name}, ${input.price ?? ''}, ${input.description ?? ''},
      ${input.photoId ?? null},
      ${input.showPhotoInGallery ?? true},
      COALESCE((SELECT max(sort_order) + 1 FROM menu_items WHERE section_id = ${input.sectionId}), 0)
    )
    RETURNING *`;
  return mapMenuItem(rows[0]);
}

export interface UpdateMenuItemInput {
  name?: string;
  price?: string;
  description?: string;
  /** `null` clears the photo; `undefined` leaves it alone. */
  photoId?: string | null;
  showPhotoInGallery?: boolean;
  sortOrder?: number;
  clearPhoto?: boolean;
}

export async function updateMenuItem(id: string, input: UpdateMenuItemInput): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    UPDATE menu_items SET
      name        = COALESCE(${input.name ?? null}, name),
      price       = COALESCE(${input.price ?? null}, price),
      description = COALESCE(${input.description ?? null}, description),
      photo_id    = CASE WHEN ${input.clearPhoto ?? false} THEN NULL
                         ELSE COALESCE(${input.photoId ?? null}::uuid, photo_id) END,
      show_photo_in_gallery = COALESCE(${input.showPhotoInGallery ?? null}, show_photo_in_gallery),
      sort_order  = COALESCE(${input.sortOrder ?? null}, sort_order),
      updated_at  = now()
    WHERE id = ${id}
    RETURNING id`;
  return rows.length > 0;
}

export async function deleteMenuItem(id: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`DELETE FROM menu_items WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}
