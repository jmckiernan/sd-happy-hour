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

export function isKvConfigured(): boolean {
  return Boolean(import.meta.env.KV_REST_API_URL && import.meta.env.KV_REST_API_TOKEN);
}

export function getKv() {
  const url = import.meta.env.KV_REST_API_URL;
  const token = import.meta.env.KV_REST_API_TOKEN;
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
  createdAt: string;
  updatedAt: string;
}

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

export function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    shareId: user.shareId,
    savedSpots: user.savedSpots || [],
  };
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string, user: User): boolean {
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
