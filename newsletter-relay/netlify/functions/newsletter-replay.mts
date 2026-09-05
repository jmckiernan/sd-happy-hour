import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Config, Context } from '@netlify/functions';
import { POST as handleNewsletterEmail } from '../../../src/pages/api/content-engine/newsletter-email';
import { getEnv } from '../../../src/lib/env';

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ errors: [message] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function authorized(request: Request): boolean {
  const expected = getEnv('NEWSLETTER_REPLAY_TOKEN');
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Operator-only recovery for a Resend event whose original delivery failed. */
export default async (request: Request, _context: Context): Promise<Response> => {
  if (request.method !== 'POST') return jsonError('Method not allowed.', 405);
  if (!authorized(request)) return jsonError('Unauthorized.', 401);

  const length = Number(request.headers.get('content-length') || '0');
  if (length > 2_048) return jsonError('Request is too large.', 413);
  const input = await request.json().catch(() => null);
  const emailId = record(input) && typeof input.emailId === 'string' ? input.emailId.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,299}$/i.test(emailId)) return jsonError('A valid emailId is required.', 422);

  const apiKey = getEnv('RESEND_API_KEY');
  const webhookId = getEnv('RESEND_WEBHOOK_ID');
  if (!apiKey || !webhookId) return jsonError('Newsletter replay is not configured.', 503);
  const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json' };
  const [emailResponse, webhookResponse] = await Promise.all([
    fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    }),
    fetch(`https://api.resend.com/webhooks/${encodeURIComponent(webhookId)}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    }),
  ]);
  if (!emailResponse.ok || !webhookResponse.ok) return jsonError('Resend recovery lookup failed.', 502);

  const [email, webhook] = await Promise.all([emailResponse.json(), webhookResponse.json()]);
  if (!record(email) || !record(webhook) || typeof webhook.signing_secret !== 'string' ||
      !webhook.signing_secret.startsWith('whsec_')) {
    return jsonError('Resend recovery lookup returned invalid data.', 502);
  }
  const from = typeof email.from === 'string' ? email.from : '';
  const to = Array.isArray(email.to) ? email.to.filter((value): value is string => typeof value === 'string') : [];
  const subject = typeof email.subject === 'string' ? email.subject : '';
  const createdAt = typeof email.created_at === 'string' ? email.created_at : new Date().toISOString();
  if (!from || !to.length || !subject) return jsonError('Received email metadata is incomplete.', 502);

  const payload = JSON.stringify({
    type: 'email.received',
    created_at: createdAt,
    data: { email_id: emailId, created_at: createdAt, from, to, subject, bcc: [], cc: [], attachments: [] },
  });
  const eventId = `manual_replay_${createHash('sha256').update(emailId).digest('hex').slice(0, 32)}`;
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signingKey = Buffer.from(webhook.signing_secret.slice(6), 'base64');
  const signature = createHmac('sha256', signingKey)
    .update(`${eventId}.${timestamp}.${payload}`)
    .digest('base64');
  const replayRequest = new Request('https://newsletter-relay.invalid/resend/newsletter-email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': eventId,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
    body: payload,
  });
  const response = await handleNewsletterEmail({ request: replayRequest } as Parameters<typeof handleNewsletterEmail>[0]);
  console.log('[newsletter-replay]', JSON.stringify({ status: response.status, emailIdHash: eventId.slice(-12) }));
  return response;
};

export const config: Config = {
  path: '/resend/newsletter-replay',
};
