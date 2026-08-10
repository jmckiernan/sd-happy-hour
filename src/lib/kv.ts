import { createClient } from '@vercel/kv';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Data layer for accounts + submissions.
//
// The original prototype of this feature (see git history: "Add backend
// submissions and saved lists") stored everything in local JSON files on a
// long-running Node server — that worked fine because `node server.js` had
// full, persistent filesystem access. Once this deploys to Vercel as
// serverless functions, local files stop working (the filesystem is
// ephemeral/read-only there), which is why production needs a real store
// (Vercel KV / Upstash Redis — see README-ACCOUNTS-SETUP.md).
//
// But `astro dev` is also just a normal local Node process with full
// filesystem access, same as the old server.js — so there's no reason
// local development should require any cloud setup at all. This falls
// back to local JSON files under `.data/` (gitignored) whenever KV isn't
// configured, and only requires KV once real KV credentials are present
// (i.e. once you've actually connected a store, typically for deploying).
// ---------------------------------------------------------------------------

const LOCAL_DATA_DIR = path.join(process.cwd(), '.data');

// Reads an env var from whichever mechanism is available. Astro API routes
// (built through Vite) populate `import.meta.env` from the real process env
// at runtime, so that's normally enough — but the scheduled alert-dispatch
// job (netlify/functions/dispatch-alerts.mts, see README-NOTIFICATIONS-SETUP.md)
// is a *standalone* Netlify Function, not built through Astro/Vite, so
// `import.meta.env` isn't populated there at all. Checking `process.env` too
// means this data layer works from both places without two copies of it.
export function getEnv(name: string): string | undefined {
  return (import.meta as any).env?.[name] ?? process.env[name];
}

export function isKvConfigured(): boolean {
  return Boolean(getEnv('KV_REST_API_URL') && getEnv('KV_REST_API_TOKEN'));
}

export function getKv() {
  const url = getEnv('KV_REST_API_URL');
  const token = getEnv('KV_REST_API_TOKEN');
  if (!url || !token) {
    throw new Error('@vercel/kv: Missing required environment variables KV_REST_API_URL and KV_REST_API_TOKEN');
  }
  return createClient({ url, token });
}

export async function readLocal<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path.join(LOCAL_DATA_DIR, `${key}.json`), 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err: any) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeLocal<T>(key: string, value: T): Promise<void> {
  await fs.mkdir(LOCAL_DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_DATA_DIR, `${key}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

export interface SavedSpot {
  spotId: number;
  status: 'favorite' | 'want-to-try' | 'been-to';
  note: string;
  // 1-5, whole stars only. Only meaningful for 'favorite'/'been-to' (you
  // haven't been somewhere you only "want to try" yet, so there's nothing
  // to rate) — omitted entirely rather than stored as 0/null when there
  // isn't one, matching how the rest of this app treats "no value" fields.
  rating?: number;
  createdAt: string;
  updatedAt: string;
}

// A saved, named filter combination the user wants to be notified about
// when a matching happy hour goes live. Filters mirror the homepage filter
// bar (src/pages/index.astro) plus a free-text query, so "does this venue
// match this alert" can be computed the same way in both places — see
// alertMatchesVenue() in lib/venues.ts.
export interface AlertFilters {
  days: string[]; // empty = any day
  neighborhood: string; // '' = any
  dealType: string; // '' = any
  feature: string; // '' = any
  query: string; // '' = no keyword filter
}

export interface AlertChannels {
  email: boolean;
  // Text is opt-in and capped/digested once notification sending exists
  // (see the alerts spec) — cost and carrier compliance make it a much
  // more limited channel than email, unlike email which is free/unlimited.
  text: boolean;
}

export interface Alert {
  id: string;
  name: string;
  filters: AlertFilters;
  channels: AlertChannels;
  active: boolean;
  // Set when this alert was cloned from someone else's shared alert
  // (src/pages/api/account/alerts/clone.ts) rather than created fresh —
  // sharing is "clone", not live-sync, so this is provenance only.
  sourceAlertId?: string;
  createdAt: string;
  updatedAt: string;
}

export const MAX_ALERTS_PER_USER = 25;

export interface User {
  id: string;
  name: string;
  email: string;
  passwordSalt: string | null;
  passwordHash: string | null;
  googleId?: string;
  picture?: string;
  shareId: string;
  savedSpots: SavedSpot[];
  // Optional/absent on accounts created before this feature shipped —
  // always read through `user.alerts || []`, never assume it's present.
  alerts?: Alert[];
  // Needed for the text channel on alerts. Absent until the user opts a
  // text-enabled alert on and supplies a number; smsConsentAt records when
  // they agreed to receive texts (compliance — see the alerts spec).
  phone?: string;
  smsConsentAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

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

const USERS_KEY = 'sdhh:users';
const SUBMISSIONS_KEY = 'sdhh:submissions';

export async function readUsers(): Promise<User[]> {
  if (!isKvConfigured()) return readLocal<User[]>('users', []);
  return (await getKv().get<User[]>(USERS_KEY)) || [];
}

export async function writeUsers(users: User[]): Promise<void> {
  if (!isKvConfigured()) return writeLocal('users', users);
  await getKv().set(USERS_KEY, users);
}

export async function readSubmissions(): Promise<Submission[]> {
  if (!isKvConfigured()) return readLocal<Submission[]>('submissions', []);
  return (await getKv().get<Submission[]>(SUBMISSIONS_KEY)) || [];
}

export async function writeSubmissions(submissions: Submission[]): Promise<void> {
  if (!isKvConfigured()) return writeLocal('submissions', submissions);
  await getKv().set(SUBMISSIONS_KEY, submissions);
}

// ---------------------------------------------------------------------------
// Restaurant accounts. A second, separate login from the consumer User
// accounts above — restaurants sign in to claim a listing and eventually
// promote deals, not to save favorites. See README-NOTIFICATIONS-SETUP.md
// for the full verification + live-toggle flow.
// ---------------------------------------------------------------------------

export interface Restaurant {
  id: string;
  name: string;
  email: string;
  passwordSalt: string | null;
  passwordHash: string | null;
  website: string; // e.g. https://joesbar.com — the business's own site
  verified: boolean;
  verificationMethod: 'domain' | 'manual' | null;
  verificationStatus: 'verified' | 'pending' | 'denied';
  claimNote: string; // proof/context submitted for manual review
  denialReason?: string;
  // Free for now; kept separate from `verified` so turning on billing later
  // doesn't require re-verifying anyone.
  plan: 'free' | 'paid';
  smsFundingEnabled: boolean;
  // The venue (public/data/happy-hours.json) this restaurant manages, set
  // by the restaurant searching/selecting their own listing during
  // onboarding. Trusted rather than admin-arbitrated for now — a known
  // limitation, see README-NOTIFICATIONS-SETUP.md.
  venueId: number | null;
  createdAt: string;
  updatedAt: string;
}

const RESTAURANTS_KEY = 'sdhh:restaurants';

export async function readRestaurants(): Promise<Restaurant[]> {
  if (!isKvConfigured()) return readLocal<Restaurant[]>('restaurants', []);
  return (await getKv().get<Restaurant[]>(RESTAURANTS_KEY)) || [];
}

export async function writeRestaurants(restaurants: Restaurant[]): Promise<void> {
  if (!isKvConfigured()) return writeLocal('restaurants', restaurants);
  await getKv().set(RESTAURANTS_KEY, restaurants);
}

export function publicRestaurant(restaurant: Restaurant) {
  return {
    id: restaurant.id,
    name: restaurant.name,
    email: restaurant.email,
    website: restaurant.website,
    verified: restaurant.verified,
    verificationMethod: restaurant.verificationMethod,
    verificationStatus: restaurant.verificationStatus,
    claimNote: restaurant.claimNote,
    denialReason: restaurant.denialReason,
    plan: restaurant.plan,
    smsFundingEnabled: restaurant.smsFundingEnabled,
    venueId: restaurant.venueId,
  };
}

/** Normalizes an email address or a website URL down to a bare domain
 * (lowercase, no protocol, no "www.", no path) so the two can be compared
 * for the domain-match auto-verification check. */
export function extractDomain(value: string): string {
  const raw = cleanString(value).toLowerCase();
  if (!raw) return '';
  const withoutProtocol = raw.replace(/^[a-z]+:\/\//, '');
  const host = withoutProtocol.split('/')[0].split('@').pop() || '';
  return host.replace(/^www\./, '');
}

// ---------------------------------------------------------------------------
// Manual "live now" overrides. public/data/happy-hours.json is static,
// git-committed data (see commitApprovedVenue in
// api/admin/submissions/[id].ts) — fine for weekly schedules, far too
// slow/heavy for a restaurant tapping "we're live now" on a whim. This is a
// small, separate, frequently-written store just for that override.
// ---------------------------------------------------------------------------

export interface LiveOverride {
  active: boolean;
  since: string;
  // Auto-expires so a forgotten toggle doesn't stay "live" forever —
  // restaurants can always re-trigger it.
  expiresAt: string;
}

const LIVE_OVERRIDES_KEY = 'sdhh:live-overrides';

export async function readLiveOverrides(): Promise<Record<number, LiveOverride>> {
  if (!isKvConfigured()) return readLocal<Record<number, LiveOverride>>('live-overrides', {});
  return (await getKv().get<Record<number, LiveOverride>>(LIVE_OVERRIDES_KEY)) || {};
}

export async function writeLiveOverrides(overrides: Record<number, LiveOverride>): Promise<void> {
  if (!isKvConfigured()) return writeLocal('live-overrides', overrides);
  await getKv().set(LIVE_OVERRIDES_KEY, overrides);
}

// ---------------------------------------------------------------------------
// Notification log. Backs dedup (don't re-notify the same user about the
// same venue within a cooldown window) and the per-user daily text cap (see
// the alerts spec, "SMS cost control"). Pruned to a rolling retention
// window on every write so it doesn't grow unbounded.
// ---------------------------------------------------------------------------

export interface NotificationLogEntry {
  id: string;
  userId: string;
  venueId: number;
  channel: 'email' | 'text';
  sentAt: string;
}

const NOTIFICATION_LOG_KEY = 'sdhh:notification-log';
const NOTIFICATION_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function readNotificationLog(): Promise<NotificationLogEntry[]> {
  if (!isKvConfigured()) return readLocal<NotificationLogEntry[]>('notification-log', []);
  return (await getKv().get<NotificationLogEntry[]>(NOTIFICATION_LOG_KEY)) || [];
}

export async function appendNotificationLog(entries: NotificationLogEntry[]): Promise<void> {
  if (!entries.length) return;
  const existing = await readNotificationLog();
  const cutoff = Date.now() - NOTIFICATION_LOG_RETENTION_MS;
  const pruned = existing.filter((entry) => new Date(entry.sentAt).getTime() >= cutoff);
  const next = [...pruned, ...entries];
  if (!isKvConfigured()) return writeLocal('notification-log', next);
  await getKv().set(NOTIFICATION_LOG_KEY, next);
}

export function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    shareId: user.shareId,
    savedSpots: user.savedSpots || [],
    alerts: user.alerts || [],
  };
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

// Structural rather than `User`-typed so Restaurant (same passwordSalt/
// passwordHash shape, different record type) can reuse this too.
export function verifyPassword(password: string, user: { passwordSalt: string | null; passwordHash: string | null }): boolean {
  if (!user.passwordSalt || !user.passwordHash) return false;
  const { hash } = hashPassword(password, user.passwordSalt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function cleanString(value: unknown): string {
  return String(value ?? '').trim();
}

export function cleanList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(cleanString).filter(Boolean);
  }
  return String(value ?? '')
    .split(/\n|,/)
    .map(cleanString)
    .filter(Boolean);
}

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

const VALID_DAYS = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

export function cleanAlertFilters(input: Record<string, any>): AlertFilters {
  return {
    days: cleanList(input?.days).filter((day) => VALID_DAYS.has(day)),
    neighborhood: cleanString(input?.neighborhood),
    dealType: cleanString(input?.dealType),
    feature: cleanString(input?.feature),
    query: cleanString(input?.query).slice(0, 80),
  };
}

export function cleanAlertChannels(input: Record<string, any> | undefined): AlertChannels {
  return {
    // Email defaults on unless explicitly turned off — it's free and
    // unlimited, so there's no cost reason to make users opt in.
    email: input?.email !== false,
    // Text defaults off — it's capped/cost-controlled, so users opt in
    // deliberately rather than getting it by default.
    text: Boolean(input?.text),
  };
}

export function validateListing(
  input: Record<string, any>,
  { requireCoordinates = false }: { requireCoordinates?: boolean } = {}
): { listing: Listing; errors: string[] } {
  const listing: Listing = {
    name: cleanString(input.name),
    neighborhood: cleanString(input.neighborhood),
    address: cleanString(input.address),
    lat: input.lat === '' || input.lat == null ? null : Number(input.lat),
    lng: input.lng === '' || input.lng == null ? null : Number(input.lng),
    days: cleanList(input.days),
    startTime: cleanString(input.startTime),
    endTime: cleanString(input.endTime),
    deals: cleanList(input.deals),
    vibe: cleanString(input.vibe),
    website: cleanString(input.website),
    verified: Boolean(input.verified),
    lastVerifiedAt: input.lastVerifiedAt || null,
    sourceUrl: cleanString(input.sourceUrl || input.website),
    dealTypes: cleanList(input.dealTypes),
    features: cleanList(input.features),
  };

  const errors: string[] = [];
  const validDays = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  if (!listing.name) errors.push('Restaurant name is required.');
  if (!listing.neighborhood) errors.push('Neighborhood is required.');
  if (!listing.address) errors.push('Address is required.');
  if (!listing.website || !/^https?:\/\//i.test(listing.website)) errors.push('Website must start with http:// or https://.');
  if (!listing.sourceUrl || !/^https?:\/\//i.test(listing.sourceUrl)) errors.push('Source URL must start with http:// or https://.');
  if (!listing.days.length || listing.days.some((day) => !validDays.has(day))) errors.push('Choose at least one valid day.');
  if (!isValidTime(listing.startTime)) errors.push('Start time must use HH:MM 24-hour format.');
  if (!isValidTime(listing.endTime)) errors.push('End time must use HH:MM 24-hour format.');
  if (!listing.deals.length) errors.push('Add at least one deal.');
  if (!listing.vibe) errors.push('Vibe is required.');
  if (requireCoordinates && (!Number.isFinite(listing.lat) || !Number.isFinite(listing.lng))) {
    errors.push('Latitude and longitude are required before approval.');
  }
  if (listing.lat != null && Number.isFinite(listing.lat) && (listing.lat < -90 || listing.lat > 90)) errors.push('Latitude is invalid.');
  if (listing.lng != null && Number.isFinite(listing.lng) && (listing.lng < -180 || listing.lng > 180)) errors.push('Longitude is invalid.');

  return { listing, errors };
}

export function validateSubmission(input: Record<string, any>) {
  const { listing, errors } = validateListing(input);
  const contact = {
    contactName: cleanString(input.contactName),
    contactEmail: cleanString(input.contactEmail),
    notes: cleanString(input.notes),
  };
  if (!contact.contactName) errors.push('Contact name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.contactEmail)) errors.push('A valid contact email is required.');
  return { listing, contact, errors };
}
