import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { getUserById, getVenueClaimByUserAndVenue, createVenueClaim, setVenueClaimPhoneCode } from '../../../../lib/store';
import { getSession } from '../../../../lib/session';
import { json, errorJson, readJsonBody } from '../../../../lib/api';
import { getVenues } from '../../../../lib/venues';
import { sendSms } from '../../../../lib/sms';

export const prerender = false;

// Texts a 6-digit code to the venue's own listed phone number (from
// happy-hours.json — never a number the claimant types in, which would
// prove nothing beyond "I can type a phone number"). Whoever's actually at
// the venue reads the text and enters the code at POST .../verify-code to
// complete the claim. This is the fallback for restaurants that don't run
// email off their own domain (see the 2026-08-12 restaurant sign-in
// redesign) — only available for venues someone has looked up a real
// number for; venues.ts's Venue.phone is absent otherwise.
const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

export const POST: APIRoute = async ({ request, cookies }) => {
  const session = await getSession(cookies);
  if (!session) return errorJson(['Sign in required.'], 401);

  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);

  let body: Record<string, any>;
  try {
    body = await readJsonBody(request);
  } catch {
    return errorJson(['Invalid JSON body.'], 400);
  }

  const venueId = Number(body.venueId);
  const venue = getVenues().find((v) => v.id === venueId);
  if (!venue) return errorJson(['Venue not found.'], 404);
  if (!venue.phone) return errorJson(['No phone number on file for this listing — submit for manual review instead.'], 422);

  let claim = await getVenueClaimByUserAndVenue(user.id, venueId);
  if (claim?.status === 'verified') return json(claim);
  if (!claim) {
    claim = await createVenueClaim({ userId: user.id, venueId, status: 'pending', verificationMethod: null });
  }

  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MS).toISOString();
  await setVenueClaimPhoneCode(claim.id, code, expiresAt, venue.phone);

  const result = await sendSms(venue.phone, `Your Happy Hour SD verification code for ${venue.name} is ${code}. Expires in 10 minutes.`);

  return json({
    sent: true,
    // In local dev without TWILIO_* configured, sms.ts logs instead of
    // sending — surface that so the dashboard can say "check the server
    // console" instead of implying a real text went out.
    simulated: result.simulated,
    expiresAt,
  });
};
