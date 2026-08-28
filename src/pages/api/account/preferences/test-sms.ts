import type { APIRoute } from 'astro';
import { getUserById } from '../../../../lib/store';
import { getSession } from '../../../../lib/session';
import { json, errorJson } from '../../../../lib/api';
import { sendSms } from '../../../../lib/sms';

export const prerender = false;

// Sends a one-off test text to the signed-in user's saved phone number so
// they can confirm Twilio is wired up before waiting on a live dispatch run.
export const POST: APIRoute = async ({ cookies }) => {
  const session = await getSession(cookies);
  if (!session || session.role !== 'user') return errorJson(['User login required.'], 401);

  const user = await getUserById(session.userId);
  if (!user) return errorJson(['User not found.'], 404);
  if (!user.phone.trim() || !user.smsConsentAt) {
    return errorJson(['Save a phone number and opt in to text alerts first.'], 422);
  }

  try {
    const result = await sendSms(
      user.phone,
      'SD Happy Hours test: text alerts are working. Max 2/day. Reply STOP to opt out.',
      { awaitDeliveryStatus: true }
    );
    return json({
      sent: result.sent,
      simulated: result.simulated,
      twilioStatus: result.twilioStatus ?? null,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      messageSid: result.messageSid ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not send test text.';
    return errorJson([message], 502);
  }
};
