import crypto from 'node:crypto';
import type { User, SavedSpot, Alert, AlertFilters, AlertChannels, Listing } from './store';

// ---------------------------------------------------------------------------
// Pure helpers with nothing to do with storage (README-NEON-MIGRATION.md §6
// step 7) — moved verbatim out of kv.ts. publicUser() has one meaningful
// signature change: since saved spots and alerts are now separate tables
// instead of nested on the User object, callers fetch them via store.ts
// (listSavedSpots/listAlerts) and pass them in explicitly. The JSON shape
// returned to the client is unchanged — every existing frontend call site
// (account.astro, index.astro) still reads `currentUser.savedSpots` /
// `currentUser.alerts` off the response.
//
// publicRestaurant() is gone — restaurants no longer have a separate
// account to redact a password from (2026-08-12 redesign). VenueClaim
// records from store.ts have nothing sensitive on them and are returned
// to clients as-is.
// ---------------------------------------------------------------------------

export function publicUser(user: User, savedSpots: SavedSpot[], alerts: Alert[]) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    shareId: user.shareId,
    savedSpots,
    alerts,
    phone: user.phone || '',
    smsOptedIn: Boolean(user.smsConsentAt),
    weeklyDigestOptIn: Boolean(user.weeklyDigestOptIn),
    hasPassword: Boolean(user.passwordHash),
  };
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

// Structural rather than `User`-typed — only User has a password today
// (restaurants sign in as regular users, see the 2026-08-12 redesign), but
// keeping this loosely typed costs nothing and avoids coupling it to one
// specific record shape.
export function verifyPassword(password: string, user: { passwordSalt: string | null; passwordHash: string | null }): boolean {
  if (!user.passwordSalt || !user.passwordHash) return false;
  const { hash } = hashPassword(password, user.passwordSalt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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
    // Optional — no format requirement beyond a light sanity check below,
    // since submitters worldwide use different phone formats and this isn't
    // security-critical at submission time (it only matters later, when a
    // claim actually gets verified against it).
    phone: cleanString(input.phone).slice(0, 20),
    // Admin-only field (the public submit form doesn't render it), so an
    // absent value is normal and means "no featured photo, use the vibe
    // stock one" rather than a validation failure.
    image: cleanString(input.image),
  };

  const errors: string[] = [];
  const validDays = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  if (!listing.name) errors.push('Restaurant name is required.');
  if (!listing.neighborhood) errors.push('Neighborhood is required.');
  if (!listing.address) errors.push('Address is required.');
  if (listing.phone && !/^\+?[0-9()\-.\s]{7,20}$/.test(listing.phone)) errors.push('That phone number doesn’t look valid.');
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
  // Either one of our own stored/committed images (a root-relative path) or a
  // remote http(s) URL. Anything else — a bare filename, a javascript: or
  // data: URI — is rejected rather than written into happy-hours.json, since
  // this value goes straight into an <img src> on a public page.
  if (listing.image && !/^(\/[^/]|https?:\/\/)/i.test(listing.image)) {
    errors.push('Featured image must be a stored image path or an http(s) URL.');
  }

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
