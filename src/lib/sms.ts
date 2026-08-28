import { getEnv } from './env';
import { normalizeUsPhone } from './phone';

// ---------------------------------------------------------------------------
// Text delivery via Twilio's plain REST API (no SDK dependency, same reason
// as email.ts). Text is the capped/cost-controlled channel — see the alerts
// spec's "SMS cost control" section for why: digesting, a daily per-user
// cap, and single-segment messages all live in lib/notify.ts, which is
// what actually decides whether to call sendSms() at all. This module is
// just the transport.
//
// Same zero-setup-locally fallback as email.ts/kv.ts: without
// TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER set, this logs instead of
// sending. See README-NOTIFICATIONS-SETUP.md for the toll-free number
// setup this expects (cheaper/faster to stand up than a full 10DLC
// campaign for the volume this app needs early on).
// ---------------------------------------------------------------------------

export interface SmsResult {
  sent: boolean;
  simulated: boolean;
  messageSid?: string;
  twilioStatus?: string;
  errorCode?: number | null;
  errorMessage?: string | null;
}

export function isSmsConfigured(): boolean {
  return Boolean(getEnv('TWILIO_ACCOUNT_SID') && getEnv('TWILIO_AUTH_TOKEN') && getEnv('TWILIO_FROM_NUMBER'));
}

async function fetchTwilioMessage(sid: string): Promise<{
  status?: string;
  errorCode?: number | null;
  errorMessage?: string | null;
}> {
  const accountSid = getEnv('TWILIO_ACCOUNT_SID');
  const token = getEnv('TWILIO_AUTH_TOKEN');
  if (!accountSid || !token) return {};

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`, {
    headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${token}`).toString('base64')}` },
  });
  if (!res.ok) return {};
  const data = await res.json();
  return {
    status: data.status,
    errorCode: data.error_code ?? null,
    errorMessage: data.error_message ?? null,
  };
}

export async function sendSms(to: string, body: string, options?: { awaitDeliveryStatus?: boolean }): Promise<SmsResult> {
  const sid = getEnv('TWILIO_ACCOUNT_SID');
  const token = getEnv('TWILIO_AUTH_TOKEN');
  const from = getEnv('TWILIO_FROM_NUMBER');

  if (!sid || !token || !from) {
    console.log(`[sms:simulated] to=${to} body=${JSON.stringify(body)}`);
    return { sent: false, simulated: true };
  }
  const normalizedTo = normalizeUsPhone(to);
  if (!normalizedTo) {
    throw new Error(`Invalid SMS recipient number: ${to}`);
  }

  const params = new URLSearchParams({ To: normalizedTo, From: from, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  let twilioStatus = data.status as string | undefined;
  let errorCode = data.error_code ?? null;
  let errorMessage = data.error_message ?? null;

  if (options?.awaitDeliveryStatus && data.sid) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const latest = await fetchTwilioMessage(data.sid);
    twilioStatus = latest.status ?? twilioStatus;
    errorCode = latest.errorCode ?? errorCode;
    errorMessage = latest.errorMessage ?? errorMessage;
  }

  return {
    sent: true,
    simulated: false,
    messageSid: data.sid,
    twilioStatus,
    errorCode,
    errorMessage,
  };
}
