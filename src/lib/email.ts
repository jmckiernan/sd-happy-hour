import { getEnv } from './env';

// ---------------------------------------------------------------------------
// Email delivery via Resend's plain REST API (no SDK dependency — same
// "talk to the REST API directly" approach kv.ts takes with Upstash). Email
// is the free, unlimited alert channel (see the alerts spec) — this has no
// per-send cap of its own; caps live on the text side (lib/sms.ts) where
// cost actually matters.
//
// Zero-setup-locally, same philosophy as kv.ts/imageStore.ts: without
// RESEND_API_KEY set, this logs instead of failing, so the whole alert
// dispatch pipeline is exercisable/testable before anyone's set up a real
// provider. See README-NOTIFICATIONS-SETUP.md.
// ---------------------------------------------------------------------------

export interface EmailResult {
  sent: boolean;
  simulated: boolean;
}

export function isEmailConfigured(): boolean {
  return Boolean(getEnv('RESEND_API_KEY'));
}

export async function sendEmail(to: string, subject: string, html: string): Promise<EmailResult> {
  const apiKey = getEnv('RESEND_API_KEY');
  const from = getEnv('RESEND_FROM_EMAIL') || 'SD Happy Hours <alerts@sdhappyhours.com>';

  if (!apiKey) {
    console.log(`[email:simulated] to=${to} subject=${JSON.stringify(subject)}`);
    return { sent: false, simulated: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${text}`);
  }

  return { sent: true, simulated: false };
}
