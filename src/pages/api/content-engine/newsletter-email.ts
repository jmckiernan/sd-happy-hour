import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { APIRoute } from 'astro';
import { errorJson, json } from '../../../lib/api';
import { runContentEngine } from '../../../lib/contentEngine/pipeline';
import {
  extractNewsletterItems,
  extractSenderEmail,
  newsletterExtractionLimits,
  parseNewsletterPayload,
  selectConfirmationLink,
  verifyResendWebhookSignature,
  NewsletterPayloadError,
  type NewsletterEmailInput,
} from '../../../lib/contentEngine/newsletterExtract';
import { sql } from '../../../lib/db';
import { getEnv } from '../../../lib/env';

export const prerender = false;

const EVENT_KEYS = new Set(['type', 'created_at', 'data']);
const EVENT_DATA_KEYS = new Set([
  'broadcast_id', 'created_at', 'email_id', 'from', 'to', 'bcc', 'cc', 'message_id',
  'subject', 'attachments', 'received_for', 'template_id', 'tags',
]);

interface ResendReceivedEvent {
  type: 'email.received';
  createdAt: string;
  emailId: string;
  from: string;
  to: string[];
  subject: string;
}

interface SubscriptionRow {
  id: string;
  publisher_name: string;
  website_url: string;
  sender_email: string | null;
  sender_domain: string | null;
  allowed_link_domains: string[] | string;
  content_source_id: string | null;
  status: string;
  confirmation_status: string;
  source_kind: string | null;
  source_enabled: boolean | null;
  match_priority: number;
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredEventString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new NewsletterPayloadError(`${field} is required.`);
  if (value.length > maximum) throw new NewsletterPayloadError(`${field} is too long.`);
  return value.trim();
}

function emailArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 25) {
    throw new NewsletterPayloadError(`${field} must contain between 1 and 25 addresses.`);
  }
  return value.map((entry, index) => requiredEventString(entry, `${field}[${index}]`, 320).toLowerCase());
}

function parseResendEvent(raw: string): ResendReceivedEvent {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new NewsletterPayloadError('Invalid JSON body.'); }
  if (!objectRecord(value)) throw new NewsletterPayloadError('JSON body must be an object.');
  const unknown = Object.keys(value).filter((key) => !EVENT_KEYS.has(key));
  if (unknown.length) throw new NewsletterPayloadError(`Unknown field: ${unknown[0]}.`);
  if (value.type !== 'email.received') throw new NewsletterPayloadError('Only email.received events are accepted.');
  if (!objectRecord(value.data)) throw new NewsletterPayloadError('data is required.');
  const unknownData = Object.keys(value.data).filter((key) => !EVENT_DATA_KEYS.has(key));
  if (unknownData.length) throw new NewsletterPayloadError(`Unknown data field: ${unknownData[0]}.`);
  const createdAt = requiredEventString(value.created_at ?? value.data.created_at, 'created_at', 100);
  if (!Number.isFinite(new Date(createdAt).valueOf())) throw new NewsletterPayloadError('created_at is invalid.');
  const emailId = requiredEventString(value.data.email_id, 'data.email_id', 300);
  const from = requiredEventString(value.data.from, 'data.from', 500);
  const to = emailArray(value.data.to, 'data.to');
  const subject = requiredEventString(value.data.subject, 'data.subject', 500);
  return { type: 'email.received', createdAt: new Date(createdAt).toISOString(), emailId, from, to, subject };
}

function parseDomainList(value: string[] | string): string[] {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string').slice(0, 25);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string').slice(0, 25) : [];
  } catch {
    return [];
  }
}

async function readBoundedResponse(response: Response, maximum: number): Promise<string> {
  const length = Number(response.headers.get('content-length') || '0');
  if (length > maximum) throw new Error('Resend email content exceeded the size limit.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new Error('Resend email content exceeded the size limit.');
    }
    output += decoder.decode(part.value, { stream: true });
  }
  return output + decoder.decode();
}

async function retrieveResendEmail(event: ResendReceivedEvent, apiKey: string): Promise<NewsletterEmailInput> {
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(event.emailId)}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Resend Receiving API returned HTTP ${response.status}.`);
  const raw = await readBoundedResponse(response, newsletterExtractionLimits.maxRetrievedEmailBytes);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new Error('Resend Receiving API returned invalid JSON.'); }
  if (!objectRecord(body)) throw new Error('Resend Receiving API returned an invalid email.');
  return parseNewsletterPayload({
    emailId: event.emailId,
    subject: body.subject ?? event.subject,
    from: (objectRecord(body.headers) ? body.headers.from : null) ?? body.from ?? event.from,
    date: body.created_at ?? event.createdAt,
    text: body.text ?? '',
    html: body.html ?? '',
    links: [],
  });
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (isIP(normalized) !== 4) return false;
  const octets = normalized.split('.').map(Number);
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) || octets[0] >= 224;
}

async function assertPublicConfirmationUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('unsafe_confirmation_url');
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => privateAddress(record.address))) throw new Error('unsafe_confirmation_url');
  return url;
}

async function visitConfirmationUrl(initialUrl: string): Promise<boolean> {
  let url = await assertPublicConfirmationUrl(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'HappyHourSD-NewsletterConfirmation/1.0' },
      signal: AbortSignal.timeout(7_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === 3) return false;
      url = await assertPublicConfirmationUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) return false;
    const body = (await readBoundedResponse(response, 64_000)).toLowerCase();
    return !/(?:captcha|verify you are human|cloudflare challenge|access denied|sign in to continue)/.test(body);
  }
  return false;
}

async function findSubscription(recipientEmails: string[], senderEmail: string): Promise<SubscriptionRow | null | 'ambiguous'> {
  const senderDomain = senderEmail.split('@')[1];
  const rows = await sql<SubscriptionRow>`
    SELECT ns.*, cs.kind AS source_kind, cs.enabled AS source_enabled,
      CASE
        WHEN lower(ns.subscriber_email) = ANY(${recipientEmails}::text[]) THEN 0
        WHEN lower(ns.sender_email) = ${senderEmail} THEN 1
        ELSE 2
      END AS match_priority
    FROM newsletter_subscriptions ns
    LEFT JOIN content_sources cs ON cs.id = ns.content_source_id
    WHERE ns.status IN ('signup_pending', 'confirmation_pending', 'active')
      AND (
        lower(ns.subscriber_email) = ANY(${recipientEmails}::text[])
        OR lower(ns.sender_email) = ${senderEmail}
        OR (ns.sender_domain IS NOT NULL AND lower(ns.sender_domain) = ${senderDomain})
      )
    ORDER BY match_priority, ns.updated_at DESC
    LIMIT 3`;
  if (!rows.length) return null;
  const best = Number(rows[0].match_priority);
  if (rows.filter((row) => Number(row.match_priority) === best).length > 1) return 'ambiguous';
  return rows[0];
}

async function finishMessage(input: {
  id: string;
  status: string;
  messageType?: string;
  itemCount?: number;
  runId?: string | null;
  error?: string | null;
}): Promise<void> {
  await sql`
    UPDATE newsletter_messages SET
      status = ${input.status}, message_type = ${input.messageType || 'newsletter'},
      extracted_item_count = ${input.itemCount || 0}, ingestion_run_id = ${input.runId || null},
      last_error = ${input.error ? input.error.slice(0, 500) : null}, processed_at = now()
    WHERE id = ${input.id}`;
}

export const POST: APIRoute = async ({ request }) => {
  const webhookSecret = getEnv('RESEND_WEBHOOK_SECRET');
  const apiKey = getEnv('RESEND_API_KEY');
  if (!webhookSecret || !apiKey) return errorJson(['Newsletter receiving is not configured.'], 503);
  const declaredLength = Number(request.headers.get('content-length') || '0');
  if (declaredLength > newsletterExtractionLimits.maxRequestBytes) return errorJson(['Request is too large.'], 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > newsletterExtractionLimits.maxRequestBytes) {
    return errorJson(['Request is too large.'], 413);
  }
  const eventId = request.headers.get('svix-id');
  if (!verifyResendWebhookSignature({
    payload: raw,
    id: eventId,
    timestamp: request.headers.get('svix-timestamp'),
    signature: request.headers.get('svix-signature'),
    secret: webhookSecret,
  })) return errorJson(['Invalid webhook signature.'], 401);

  let event: ResendReceivedEvent;
  try { event = parseResendEvent(raw); }
  catch (error) {
    return errorJson([error instanceof Error ? error.message : 'Invalid webhook payload.'], 422);
  }
  const senderEmail = extractSenderEmail(event.from);
  if (!senderEmail) return errorJson(['The sender address is invalid.'], 422);
  const subscription = await findSubscription(event.to, senderEmail);
  if (subscription === 'ambiguous') return errorJson(['Sender matches multiple newsletter subscriptions.'], 409);
  if (!subscription) return json({ accepted: true, ignored: true, reason: 'unknown_sender' }, 202);

  const digest = createHash('sha256').update(raw).digest('hex');
  const inserted = await sql<{ id: string }>`
    INSERT INTO newsletter_messages (
      subscription_id, content_source_id, resend_event_id, resend_email_id,
      payload_sha256, sender_email, subject, sent_at
    ) VALUES (
      ${subscription.id}, ${subscription.content_source_id}, ${eventId!}, ${event.emailId},
      ${digest}, ${senderEmail}, ${event.subject}, ${event.createdAt}
    )
    ON CONFLICT DO NOTHING
    RETURNING id`;
  let messageId = inserted[0]?.id;
  if (!messageId) {
    const existing = await sql<{ id: string; status: string }>`
      SELECT id, status FROM newsletter_messages
      WHERE resend_event_id = ${eventId!} OR resend_email_id = ${event.emailId}
      ORDER BY received_at DESC LIMIT 1`;
    if (!existing[0] || existing[0].status !== 'failed') {
      return json({ accepted: true, duplicate: true });
    }
    messageId = existing[0].id;
    await sql`
      UPDATE newsletter_messages SET status = 'processing', last_error = NULL,
        processed_at = NULL WHERE id = ${messageId}`;
  }

  try {
    const email = await retrieveResendEmail(event, apiKey);
    const fullSender = extractSenderEmail(email.from);
    if (!fullSender || fullSender !== senderEmail) throw new Error('Retrieved email sender did not match the signed webhook.');

    if (subscription.status !== 'active') {
      const confirmation = selectConfirmationLink(email);
      if (confirmation.status === 'manual_required') {
        const reason = confirmation.reason;
        await sql`
          UPDATE newsletter_subscriptions SET confirmation_status = 'manual_required',
            last_error = ${`Confirmation requires review: ${reason}.`} WHERE id = ${subscription.id}`;
        await finishMessage({ id: messageId, status: 'manual_required', messageType: 'confirmation', error: reason });
        return json({ accepted: true, confirmation: 'manual_required', reason }, 202);
      }
      if (confirmation.status === 'ready') {
        const confirmed = await visitConfirmationUrl(confirmation.url).catch(() => false);
        if (!confirmed) {
          await sql`
            UPDATE newsletter_subscriptions SET confirmation_status = 'manual_required',
              last_error = 'Confirmation link was challenged or failed.' WHERE id = ${subscription.id}`;
          await finishMessage({ id: messageId, status: 'manual_required', messageType: 'confirmation', error: 'confirmation_failed' });
          return json({ accepted: true, confirmation: 'manual_required', reason: 'confirmation_failed' }, 202);
        }
        await sql`
          UPDATE newsletter_subscriptions SET confirmation_status = 'confirmed', confirmed_at = now(),
            status = CASE WHEN content_source_id IS NOT NULL THEN 'active' ELSE 'discovered' END,
            sender_email = COALESCE(sender_email, ${senderEmail}),
            sender_domain = COALESCE(sender_domain, ${senderEmail.split('@')[1]}),
            last_error = NULL WHERE id = ${subscription.id}`;
        await finishMessage({ id: messageId, status: 'confirmation_handled', messageType: 'confirmation' });
        return json({ accepted: true, confirmation: 'confirmed' });
      }

      // Some publishers use single opt-in and the first inbound message is the
      // newsletter itself. Delivery to the subscription's unique Resend alias
      // is sufficient evidence that this one target is active.
      await sql`
        UPDATE newsletter_subscriptions SET status = CASE
            WHEN content_source_id IS NOT NULL THEN 'active' ELSE 'discovered' END,
          confirmation_status = 'confirmed', confirmed_at = COALESCE(confirmed_at, now()),
          sender_email = COALESCE(sender_email, ${senderEmail}),
          sender_domain = COALESCE(sender_domain, ${senderEmail.split('@')[1]}),
          last_error = NULL WHERE id = ${subscription.id}`;
    }

    if (!subscription.content_source_id || subscription.source_kind !== 'webhook' || !subscription.source_enabled) {
      throw new Error('Newsletter subscription is not mapped to an enabled webhook source.');
    }
    const items = extractNewsletterItems(email, {
      publisherName: subscription.publisher_name,
      websiteUrl: subscription.website_url,
      allowedLinkDomains: parseDomainList(subscription.allowed_link_domains),
    });
    if (!items.length) {
      await sql`UPDATE newsletter_subscriptions SET last_message_at = now() WHERE id = ${subscription.id}`;
      await finishMessage({ id: messageId, status: 'ignored' });
      return json({ accepted: true, ignored: true, reason: 'no_official_content_links' }, 202);
    }
    const summary = await runContentEngine({
      triggerType: 'event',
      sourceIds: [subscription.content_source_id],
      injectedItems: { [subscription.content_source_id]: items },
    });
    const failed = summary.status === 'failed';
    await finishMessage({
      id: messageId,
      status: failed ? 'failed' : 'processed',
      itemCount: items.length,
      runId: summary.runId,
      error: failed ? 'Content engine ingestion failed.' : null,
    });
    await sql`UPDATE newsletter_subscriptions SET last_message_at = now(), last_error = NULL WHERE id = ${subscription.id}`;
    return json({ accepted: true, items: items.length, summary }, failed ? 502 : 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Newsletter processing failed.';
    await finishMessage({ id: messageId, status: 'failed', error: message }).catch(() => {});
    return errorJson(['Newsletter processing failed.'], 502);
  }
};
