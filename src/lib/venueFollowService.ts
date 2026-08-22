import { withTransaction } from './db';
import {
  deleteVenueFollow,
  getVenueFollowForUpdate,
  listVenueFollows,
  replaceVenueFollow,
  type VenueFollow,
} from './venueFollowRepo';
import { getVenueById } from './venues';

export class VenueFollowServiceError extends Error {
  status: number;
  code: 'invalid_request' | 'venue_not_found' | 'user_not_found';
  errors: string[];

  constructor(
    status: number,
    code: VenueFollowServiceError['code'],
    errors: string[]
  ) {
    super(errors.join(' '));
    this.name = 'VenueFollowServiceError';
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export interface VenueFollowPatch {
  happyHourAlertsEnabled?: boolean;
  promotionAlertsEnabled?: boolean;
  channels?: {
    email?: boolean;
    text?: boolean;
  };
}

export interface AccountVenueFollowsResult {
  follows: VenueFollow[];
  smsTextEligible: boolean;
}

export interface SaveVenueFollowResult {
  follow: VenueFollow;
  smsTextEligible: boolean;
}

interface SmsEligibilityRow {
  phone: string;
  sms_consent_at: Date | string | null;
}

function smsTextEligible(user: SmsEligibilityRow | undefined): boolean {
  return Boolean(user?.phone.trim() && user.sms_consent_at);
}

function requireVenue(venueId: number): void {
  if (!Number.isSafeInteger(venueId) || venueId <= 0) {
    throw new VenueFollowServiceError(400, 'invalid_request', ['Invalid venue id.']);
  }
  if (!getVenueById(venueId)) {
    throw new VenueFollowServiceError(404, 'venue_not_found', ['Venue not found.']);
  }
}

export async function listAccountVenueFollows(userId: string): Promise<AccountVenueFollowsResult> {
  return withTransaction(async (tx) => {
    const users = await tx<SmsEligibilityRow>`
      SELECT phone, sms_consent_at FROM users
      WHERE id = ${userId}`;
    const follows = await listVenueFollows(userId, tx);
    return { follows, smsTextEligible: smsTextEligible(users[0]) };
  });
}

export async function saveVenueFollow(
  userId: string,
  venueId: number,
  patch: VenueFollowPatch
): Promise<SaveVenueFollowResult> {
  requireVenue(venueId);
  return withTransaction(async (tx) => {
    const users = await tx<SmsEligibilityRow>`
      SELECT phone, sms_consent_at FROM users
      WHERE id = ${userId}
      FOR SHARE`;
    const user = users[0];
    if (!user) throw new VenueFollowServiceError(404, 'user_not_found', ['User not found.']);

    const existing = await getVenueFollowForUpdate(userId, venueId, tx);
    const next = {
      happyHourAlertsEnabled:
        patch.happyHourAlertsEnabled ?? existing?.happyHourAlertsEnabled ?? false,
      promotionAlertsEnabled:
        patch.promotionAlertsEnabled ?? existing?.promotionAlertsEnabled ?? true,
      channelEmail: patch.channels?.email ?? existing?.channels.email ?? true,
      channelText: patch.channels?.text ?? existing?.channels.text ?? false,
    };
    const follow = await replaceVenueFollow(userId, venueId, next, tx);
    return { follow, smsTextEligible: smsTextEligible(user) };
  });
}

export async function removeVenueFollow(userId: string, venueId: number): Promise<boolean> {
  requireVenue(venueId);
  return deleteVenueFollow(userId, venueId);
}
