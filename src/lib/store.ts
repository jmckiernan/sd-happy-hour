import crypto from 'node:crypto';
import { sql, withTransaction, type QueryExecutor } from './db';

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
  sourceAlertId?: string;
}

// Enforces MAX_ALERTS_PER_USER inside the insert itself (§4's "alerts" note)
// rather than a separate count-then-insert, which would race under
// concurrent requests. Returns null when the cap is hit (zero rows back).
export async function createAlert(userId: string, input: CreateAlertInput): Promise<Alert | null> {
  const rows = await sql<AlertRow>`
    INSERT INTO alerts (user_id, name, filters, channel_email, channel_text, source_alert_id)
    SELECT ${userId}, ${input.name}, ${JSON.stringify(input.filters)}::jsonb, ${input.channels.email}, ${input.channels.text}, ${input.sourceAlertId ?? null}
    WHERE (SELECT count(*) FROM alerts WHERE user_id = ${userId}) < ${MAX_ALERTS_PER_USER}
    RETURNING *`;
  return rows[0] ? mapAlert(rows[0]) : null;
}

export interface UpdateAlertInput {
  name?: string;
  filters?: AlertFilters;
  channels?: AlertChannels;
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
// =============================================================================

export type SessionRole = 'user' | 'restaurant';

export interface SessionRecord {
  id: string;
  role: SessionRole;
  userId: string | null;
  restaurantId: string | null;
  expiresAt: string;
}

interface SessionRow {
  id: string;
  role: SessionRole;
  user_id: string | null;
  restaurant_id: string | null;
  expires_at: string;
}

function mapSession(row: SessionRow): SessionRecord {
  return { id: row.id, role: row.role, userId: row.user_id, restaurantId: row.restaurant_id, expiresAt: row.expires_at };
}

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours, matches the original

export async function createSession(role: SessionRole, subjectId: string): Promise<SessionRecord> {
  const id = crypto.randomBytes(32).toString('hex');
  const rows = await sql<SessionRow>`
    INSERT INTO sessions (id, role, user_id, restaurant_id, expires_at)
    VALUES (
      ${id}, ${role},
      ${role === 'user' ? subjectId : null},
      ${role === 'restaurant' ? subjectId : null},
      now() + make_interval(secs => ${SESSION_MAX_AGE_SECONDS})
    )
    RETURNING *`;
  return mapSession(rows[0]);
}

// Only ever returns unexpired sessions — an expired row is treated the same
// as no row, matching the old TTL behavior where Redis just wouldn't have it.
export async function getSessionById(id: string): Promise<SessionRecord | null> {
  const rows = await sql<SessionRow>`SELECT * FROM sessions WHERE id = ${id} AND expires_at > now()`;
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
// Restaurants
// =============================================================================

export interface Restaurant {
  id: string;
  name: string;
  email: string;
  passwordSalt: string | null;
  passwordHash: string | null;
  website: string;
  verified: boolean;
  verificationMethod: 'domain' | 'manual' | null;
  verificationStatus: 'verified' | 'pending' | 'denied';
  claimNote: string;
  denialReason?: string;
  plan: 'free' | 'paid';
  smsFundingEnabled: boolean;
  venueId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface RestaurantRow {
  id: string;
  name: string;
  email: string;
  password_salt: string | null;
  password_hash: string | null;
  website: string;
  verified: boolean;
  verification_method: 'domain' | 'manual' | null;
  verification_status: 'verified' | 'pending' | 'denied';
  claim_note: string;
  denial_reason: string | null;
  plan: 'free' | 'paid';
  sms_funding_enabled: boolean;
  venue_id: number | null;
  created_at: string;
  updated_at: string;
}

function mapRestaurant(row: RestaurantRow): Restaurant {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    website: row.website,
    verified: row.verified,
    verificationMethod: row.verification_method,
    verificationStatus: row.verification_status,
    claimNote: row.claim_note,
    denialReason: row.denial_reason ?? undefined,
    plan: row.plan,
    smsFundingEnabled: row.sms_funding_enabled,
    venueId: row.venue_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getRestaurantById(id: string): Promise<Restaurant | null> {
  const rows = await sql<RestaurantRow>`SELECT * FROM restaurants WHERE id = ${id}`;
  return rows[0] ? mapRestaurant(rows[0]) : null;
}

export async function getRestaurantByEmail(email: string): Promise<Restaurant | null> {
  const rows = await sql<RestaurantRow>`SELECT * FROM restaurants WHERE lower(email) = lower(${email})`;
  return rows[0] ? mapRestaurant(rows[0]) : null;
}

export async function listRestaurants(): Promise<Restaurant[]> {
  const rows = await sql<RestaurantRow>`SELECT * FROM restaurants ORDER BY created_at DESC`;
  return rows.map(mapRestaurant);
}

export interface CreateRestaurantInput {
  name: string;
  email: string;
  passwordSalt: string;
  passwordHash: string;
  website: string;
  verified: boolean;
  verificationMethod: 'domain' | 'manual' | null;
  verificationStatus: 'verified' | 'pending' | 'denied';
}

export async function createRestaurant(input: CreateRestaurantInput): Promise<Restaurant> {
  const rows = await sql<RestaurantRow>`
    INSERT INTO restaurants (name, email, password_salt, password_hash, website, verified, verification_method, verification_status)
    VALUES (${input.name}, ${input.email}, ${input.passwordSalt}, ${input.passwordHash}, ${input.website}, ${input.verified}, ${input.verificationMethod}, ${input.verificationStatus})
    RETURNING *`;
  return mapRestaurant(rows[0]);
}

export interface UpdateRestaurantInput {
  claimNote?: string;
  verificationStatus?: 'verified' | 'pending' | 'denied';
  verificationMethod?: 'domain' | 'manual' | null;
  verified?: boolean;
  denialReason?: string | null;
  venueId?: number | null;
}

// Explicit `hasOwnProperty`-style sentinels aren't needed here because every
// caller in Phase 3 passes a fully-formed patch for the fields it wants to
// touch (mirroring how the old kv.ts call sites mutated specific fields on
// the in-memory object) — undefined means "leave alone" via COALESCE, while
// denialReason/venueId explicitly pass null to clear.
export async function updateRestaurant(id: string, input: UpdateRestaurantInput): Promise<Restaurant | null> {
  const rows = await sql<RestaurantRow>`
    UPDATE restaurants SET
      claim_note          = COALESCE(${input.claimNote ?? null}, claim_note),
      verification_status = COALESCE(${input.verificationStatus ?? null}, verification_status),
      verification_method = CASE WHEN ${input.verificationMethod !== undefined} THEN ${input.verificationMethod ?? null} ELSE verification_method END,
      verified             = COALESCE(${input.verified ?? null}, verified),
      denial_reason        = CASE WHEN ${input.denialReason !== undefined} THEN ${input.denialReason ?? null} ELSE denial_reason END,
      venue_id              = CASE WHEN ${input.venueId !== undefined} THEN ${input.venueId ?? null} ELSE venue_id END
    WHERE id = ${id}
    RETURNING *`;
  return rows[0] ? mapRestaurant(rows[0]) : null;
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
  sentAt: string;
}

interface NotificationLogRow {
  user_id: string;
  venue_id: number;
  channel: 'email' | 'text';
  sent_at: string;
}

function mapNotification(row: NotificationLogRow): NotificationLogEntry {
  return { userId: row.user_id, venueId: row.venue_id, channel: row.channel, sentAt: row.sent_at };
}

// Everything at or after `sinceIso` — the dispatch job passes the earlier of
// its cooldown cutoff and its daily-cap day-start so one query covers both
// (see notify.ts).
export async function listNotificationsSince(sinceIso: string): Promise<NotificationLogEntry[]> {
  const rows = await sql<NotificationLogRow>`
    SELECT user_id, venue_id, channel, sent_at FROM notification_log WHERE sent_at >= ${sinceIso}`;
  return rows.map(mapNotification);
}

export async function insertNotifications(entries: NotificationLogEntry[]): Promise<void> {
  if (!entries.length) return;
  await withTransaction(async (txSql) => {
    for (const entry of entries) {
      await txSql`INSERT INTO notification_log (user_id, venue_id, channel, sent_at) VALUES (${entry.userId}, ${entry.venueId}, ${entry.channel}, ${entry.sentAt})`;
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

export type { QueryExecutor };
