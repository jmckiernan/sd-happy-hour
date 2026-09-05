#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INVENTORY = path.join(ROOT, '.data', 'newsletters', 'inventory.json');
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
const receivingAddress = String(process.env.RESEND_RECEIVING_ADDRESS || '').trim().toLowerCase();

function option(name, fallback = '') {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return value === undefined ? fallback : value;
}

if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required.');
if (!/^\S+@\S+\.\S+$/.test(receivingAddress)) {
  throw new Error('RESEND_RECEIVING_ADDRESS must be the dedicated Resend inbound address.');
}

function aliasFor(host) {
  const domain = receivingAddress.split('@')[1];
  const slug = host.replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 38);
  const suffix = createHash('sha256').update(host).digest('hex').slice(0, 8);
  return `venue-${slug || 'newsletter'}-${suffix}@${domain}`;
}

function publisherName(target) {
  return target.venueNames?.[0] || target.host;
}

function sourceUrl(target) {
  const url = new URL(target.website);
  url.hash = 'newsletter-email';
  return url.toString();
}

function status(target) {
  if (target.status === 'submitted') return ['confirmation_pending', 'pending'];
  if (target.status === 'confirmed') return ['active', 'confirmed'];
  if (['error', 'manual_required', 'no_newsletter'].includes(target.status)) return ['failed', 'not_requested'];
  return ['signup_pending', 'not_requested'];
}

function domain(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return null }
}

const inventory = JSON.parse(await readFile(INVENTORY, 'utf8'));
const requestedHost = String(option('host')).trim().toLowerCase();
const requestedLimit = Math.max(0, Number(option('limit', '0')) || 0);
let targets = inventory.targets || [];
if (requestedHost) targets = targets.filter((target) => target.host === requestedHost);
if (requestedLimit) targets = targets.slice(0, requestedLimit);
if (!targets.length) throw new Error('No newsletter inventory targets matched the requested scope.');
const client = new pg.Client({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('BEGIN');
  let synced = 0;
  for (const target of targets) {
    const publisher = publisherName(target);
    const source = await client.query(`
      INSERT INTO content_sources (
        name, kind, url, enabled, trust_score, county_scoped, image_policy, config
      ) VALUES ($1, 'webhook', $2, true, 0.860, true, 'none', $3::jsonb)
      ON CONFLICT (url) DO UPDATE SET
        name = EXCLUDED.name,
        config = EXCLUDED.config,
        enabled = true
      RETURNING id
    `, [
      `Venue newsletter — ${publisher}`,
      sourceUrl(target),
      JSON.stringify({
        publisher,
        defaultVenue: publisher,
        defaultArea: target.neighborhoods?.[0] || undefined,
        includeKeywords: [],
      }),
    ]);
    const [subscriptionStatus, confirmationStatus] = status(target);
    const subscriberEmail = target.subscriberEmail || aliasFor(target.host);
    const allowedLinkDomains = [domain(target.website)].filter(Boolean);
    const senderDomain = target.senderDomain || null;
    const senderEmail = target.senderEmail || null;
    await client.query(`
      INSERT INTO newsletter_subscriptions (
        venue_id, publisher_name, subscriber_email, website_url, signup_url,
        sender_email, sender_domain, allowed_link_domains, content_source_id,
        status, confirmation_status, confirmed_at, last_error, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11,
        $12::timestamptz, $13, $14::jsonb
      )
      ON CONFLICT (publisher_name, website_url) DO UPDATE SET
        venue_id = EXCLUDED.venue_id,
        subscriber_email = EXCLUDED.subscriber_email,
        signup_url = EXCLUDED.signup_url,
        sender_email = COALESCE(EXCLUDED.sender_email, newsletter_subscriptions.sender_email),
        sender_domain = COALESCE(EXCLUDED.sender_domain, newsletter_subscriptions.sender_domain),
        allowed_link_domains = EXCLUDED.allowed_link_domains,
        content_source_id = EXCLUDED.content_source_id,
        status = EXCLUDED.status,
        confirmation_status = EXCLUDED.confirmation_status,
        confirmed_at = COALESCE(EXCLUDED.confirmed_at, newsletter_subscriptions.confirmed_at),
        last_error = EXCLUDED.last_error,
        metadata = EXCLUDED.metadata
    `, [
      target.venueIds?.[0] || null,
      publisher,
      subscriberEmail,
      target.website,
      target.newsletterUrl || null,
      senderEmail,
      senderDomain,
      JSON.stringify(allowedLinkDomains),
      source.rows[0].id,
      subscriptionStatus,
      confirmationStatus,
      target.confirmedAt || null,
      ['error', 'manual_required'].includes(target.status) ? target.detail || target.status : null,
      JSON.stringify({
        host: target.host,
        source: target.source,
        venueIds: target.venueIds || [],
        venueNames: target.venueNames || [],
        neighborhoods: target.neighborhoods || [],
        rating: target.rating ?? null,
        reviewCount: target.reviewCount ?? null,
        inventoryStatus: target.status,
        attemptedAt: target.attemptedAt || null,
      }),
    ]);
    synced += 1;
  }
  await client.query('COMMIT');
  console.log(`Synced ${synced} newsletter targets into Postgres.`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
