import crypto from 'node:crypto';
import type { User, SavedSpot, Alert, AlertFilters, AlertChannels, Listing } from './store';
import type { UnifiedSavedState } from './savedLists';
import { PROMOTION_TYPES, type PromotionType } from './promotionState';
import { normalizeImageFraming } from './imageCrop';
import { parseInstant, type InstantInput } from './sanDiegoTime';

// ---------------------------------------------------------------------------
// Pure helpers with nothing to do with storage (README-NEON-MIGRATION.md §6
// step 7) — moved verbatim out of kv.ts. publicUser() has one meaningful
// signature change: since saved spots and alerts are now separate tables
// instead of nested on the User object, callers fetch them via store.ts
// (listSavedSpots/listAlerts) and pass them in explicitly. The JSON shape
// returned to older clients is preserved while the unified `saved` object
// carries canonical multi-list memberships for current frontend call sites.
//
// publicRestaurant() is gone — restaurants no longer have a separate
// account to redact a password from (2026-08-12 redesign). VenueClaim
// records from store.ts have nothing sensitive on them and are returned
// to clients as-is.
// ---------------------------------------------------------------------------

export function publicUser(
  user: User,
  savedSpots: SavedSpot[],
  alerts: Alert[],
  saved?: UnifiedSavedState
) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    shareId: user.shareId,
    savedSpots,
    ...(saved ? { saved } : {}),
    alerts,
    phone: user.phone || '',
    smsOptedIn: Boolean(user.smsConsentAt),
    weeklyDigestOptIn: Boolean(user.weeklyDigestOptIn),
    locationAnalyticsOptIn: Boolean(user.locationAnalyticsConsentAt && !user.locationAnalyticsRevokedAt),
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

export { normalizeUsPhone } from './phone';

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

export const ALERT_KINDS = ['happy_hour', 'promotion'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * Omitted legacy input keeps the pre-redesign behavior (happy-hour alerts
 * only). An explicitly supplied empty/invalid list remains empty so an API
 * validator can reject it instead of silently changing the user's choice.
 */
export function cleanAlertKinds(
  value: unknown,
  omittedDefault: readonly AlertKind[] = ['happy_hour']
): AlertKind[] {
  if (value === undefined) return [...omittedDefault];
  const supplied = cleanList(value);
  return ALERT_KINDS.filter((kind) => supplied.includes(kind));
}

export function validateAlertKinds(value: unknown): { alertKinds: AlertKind[]; errors: string[] } {
  const alertKinds = cleanAlertKinds(value);
  if (value === undefined) return { alertKinds, errors: [] };

  const supplied = cleanList(value);
  const unknown = supplied.filter((kind) => !ALERT_KINDS.includes(kind as AlertKind));
  const errors: string[] = [];
  if (!supplied.length) errors.push('Choose at least one alert kind.');
  if (unknown.length) errors.push('Alert kinds may only include happy_hour or promotion.');
  return { alertKinds, errors };
}

export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export const PROMOTION_TITLE_MAX_LENGTH = 80;
export const PROMOTION_DESCRIPTION_MAX_LENGTH = 200;
export const PROMOTION_DEAL_CODE_MAX_LENGTH = 30;
export const MAX_PROMOTION_DURATION_MS = 24 * 60 * 60 * 1000;

export type PromotionValidationMode = 'draft' | 'publish';

export interface CleanPromotionInput {
  type: PromotionType;
  title: string;
  description: string;
  dealCode: string | null;
  imageKey: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

export interface ValidatePromotionOptions {
  mode?: PromotionValidationMode;
}

function cleanPromotionInstant(value: unknown): Date | null {
  if (value instanceof Date || typeof value === 'number' || typeof value === 'string') {
    return parseInstant(value as InstantInput);
  }
  return null;
}

/**
 * Shared server-side validation for new/edited promotion content. Merchant
 * San Diego-local form values must be converted with
 * parseSanDiegoLocalDateTime() before reaching this function; offsetless
 * strings are never interpreted in the runtime machine's timezone.
 */
export function validatePromotionInput(
  input: Record<string, any>,
  options: ValidatePromotionOptions = {}
): { promotion: CleanPromotionInput; errors: string[] } {
  const mode = options.mode ?? 'draft';
  const type = cleanString(input.type) as PromotionType;
  const title = cleanString(input.title);
  const description = cleanString(input.description);
  const rawDealCode = cleanString(input.dealCode);
  const rawImageKey = cleanString(input.imageKey);
  const startsAt = cleanPromotionInstant(input.startsAt);
  const endsAt = cleanPromotionInstant(input.endsAt);
  const hasStartInput = input.startsAt !== undefined && input.startsAt !== null && input.startsAt !== '';
  const hasEndInput = input.endsAt !== undefined && input.endsAt !== null && input.endsAt !== '';

  const promotion: CleanPromotionInput = {
    type,
    title,
    description,
    dealCode: rawDealCode || null,
    imageKey: rawImageKey || null,
    startsAt: startsAt?.toISOString() ?? null,
    endsAt: endsAt?.toISOString() ?? null,
  };
  const errors: string[] = [];

  if (!PROMOTION_TYPES.includes(type)) errors.push('Choose a supported promotion type.');
  if (mode === 'publish' && !title) errors.push('Promotion headline is required before publishing.');
  else if (title.length > PROMOTION_TITLE_MAX_LENGTH) {
    errors.push(`Promotion headline must be ${PROMOTION_TITLE_MAX_LENGTH} characters or fewer.`);
  }
  if (description.length > PROMOTION_DESCRIPTION_MAX_LENGTH) {
    errors.push(`Promotion details must be ${PROMOTION_DESCRIPTION_MAX_LENGTH} characters or fewer.`);
  }
  if (rawDealCode.length > PROMOTION_DEAL_CODE_MAX_LENGTH) {
    errors.push(`Deal code must be ${PROMOTION_DEAL_CODE_MAX_LENGTH} characters or fewer.`);
  }
  if (rawImageKey && !/^[a-zA-Z0-9._-]{1,240}$/.test(rawImageKey)) {
    errors.push('Promotion image is invalid. Upload it again.');
  }

  if (hasStartInput && !startsAt) errors.push('Promotion start must be a valid absolute timestamp.');
  if (hasEndInput && !endsAt) errors.push('Promotion end must be a valid absolute timestamp.');
  if (mode === 'publish' && !hasStartInput) errors.push('Promotion start is required before publishing.');
  if (mode === 'publish' && !hasEndInput) errors.push('Promotion end is required before publishing.');
  if (hasStartInput !== hasEndInput) errors.push('Promotion start and end must be provided together.');

  if (startsAt && endsAt) {
    const duration = endsAt.getTime() - startsAt.getTime();
    if (duration <= 0) errors.push('Promotion end must be later than its start.');
    else if (duration > MAX_PROMOTION_DURATION_MS) {
      errors.push('Promotion duration cannot exceed 24 hours.');
    }
  }

  return { promotion, errors };
}

export const validatePromotion = validatePromotionInput;

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
    openTime: cleanString(input.openTime),
    closeTime: cleanString(input.closeTime),
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
  // Keep these optional on legacy repository records rather than writing
  // empty keys during an unrelated admin save.
  if (!listing.openTime) delete listing.openTime;
  if (!listing.closeTime) delete listing.closeTime;

  // The featured photo's framing, one crop per frame. Out-of-range or centered
  // values normalize away rather than failing the save: these are frames an
  // admin dragged, not typed fields. Cleared along with the photo, since
  // framing a stock vibe image means nothing.
  //
  // Explicitly null rather than absent when there is no framing, for the same
  // reason `image` is kept as an empty string: the venue editor diffs this
  // record against the one it loaded and merges the difference over the stored
  // row, so "put it back to centered" has to be a value it can see. The key
  // stops existing at the point of the commit — see withoutEmptyImage() in
  // lib/venueRepo.ts.
  listing.imageCrop = listing.image ? normalizeImageFraming(input.imageCrop) : null;

  const errors: string[] = [];
  const validDays = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  if (!listing.name) errors.push('Restaurant name is required.');
  if (!listing.neighborhood) errors.push('Neighborhood is required.');
  if (!listing.address) errors.push('Address is required.');
  if (listing.phone && !/^\+?[0-9()\-.\s]{7,20}$/.test(listing.phone)) errors.push('That phone number doesn’t look valid.');
  if (!listing.website || !/^https?:\/\//i.test(listing.website)) errors.push('Website must start with http:// or https://.');
  if (!listing.sourceUrl || !/^https?:\/\//i.test(listing.sourceUrl)) errors.push('Source URL must start with http:// or https://.');
  if (!listing.days.length || listing.days.some((day) => !validDays.has(day))) errors.push('Choose at least one valid day.');
  if (Boolean(listing.openTime) !== Boolean(listing.closeTime)) {
    errors.push('Add both venue open and close times, or leave both blank.');
  }
  if (listing.openTime && !isValidTime(listing.openTime)) errors.push('Venue open time must use HH:MM 24-hour format.');
  if (listing.closeTime && !isValidTime(listing.closeTime)) errors.push('Venue close time must use HH:MM 24-hour format.');
  if (!isValidTime(listing.startTime)) errors.push('Happy hour start time must use HH:MM 24-hour format.');
  if (!isValidTime(listing.endTime)) errors.push('Happy hour end time must use HH:MM 24-hour format.');
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
