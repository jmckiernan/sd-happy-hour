import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = [
  '0001_init.sql',
  '0002_venue_claims.sql',
  '0003_images.sql',
  '0004_venue_content.sql',
  '0005_photo_types.sql',
  '0006_auto_publish_photos.sql',
  '0007_live_promotions_foundation.sql',
];

function parseDatabaseUrl(raw, label) {
  try {
    const parsed = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a valid postgres:// or postgresql:// URL.`);
  }
}

function targetIdentity(parsed) {
  const port = parsed.port || '5432';
  return `${parsed.hostname.toLowerCase()}:${port}${parsed.pathname}`;
}

function requireDisposableTestDatabase(env = process.env) {
  if (env.TEST_DATABASE_DISPOSABLE !== '1') {
    throw new Error('TEST_DATABASE_DISPOSABLE=1 is required to confirm that the test database may be modified.');
  }

  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new Error(
      'TEST_DATABASE_URL is required. Create an explicitly disposable database whose name contains "test"; no other database variable is used.'
    );
  }

  const parsed = parseDatabaseUrl(raw, 'TEST_DATABASE_URL');
  for (const [key] of parsed.searchParams) {
    if (['options', 'search_path'].includes(key.toLowerCase())) {
      throw new Error('TEST_DATABASE_URL must not override options or search_path.');
    }
  }
  for (const variable of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    const otherRaw = env[variable]?.trim();
    if (!otherRaw) continue;
    if (otherRaw === raw) {
      throw new Error(`Refusing to use TEST_DATABASE_URL because it is also configured as ${variable}.`);
    }
    const other = parseDatabaseUrl(otherRaw, variable);
    if (targetIdentity(other) === targetIdentity(parsed)) {
      throw new Error(`Refusing to use TEST_DATABASE_URL because it targets the same database as ${variable}.`);
    }
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  const forbiddenNames = new Set([
    '',
    'postgres',
    'template0',
    'template1',
    'neondb',
    'defaultdb',
    'main',
    'prod',
    'production',
  ]);
  if (forbiddenNames.has(databaseName)) {
    throw new Error('Refusing an unsafe system, default, or production-looking TEST_DATABASE_URL database name.');
  }
  if (!/(^|[-_])(test|testing|disposable|scratch|tmp)([-_]|$)/i.test(databaseName)) {
    throw new Error('The TEST_DATABASE_URL database name must contain a distinct test/disposable/scratch/tmp marker.');
  }

  return { raw, parsed };
}

function isLocalDatabase(parsed) {
  return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase());
}

function quoteIdentifier(value) {
  assert.match(value, /^[a-z][a-z0-9_]+$/);
  return `"${value}"`;
}

function normalized(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
  }
  return value;
}

async function applyMigration(client, file) {
  const sql = await readFile(path.join(ROOT, 'migrations', file), 'utf8');
  const version = file.replace(/\.sql$/, '');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`Migration ${file} failed: ${error.message}`);
  }
}

// Mirrors the production runner's recorded-version decision without invoking
// scripts/migrate.js, whose bootstrap lookup is intentionally fixed to the
// public schema. This test must never point that runner at its temporary schema.
async function applyMigrationUnlessRecorded(client, file) {
  const version = file.replace(/\.sql$/, '');
  const bookkeeping = await client.query("SELECT to_regclass('schema_migrations') AS reg");
  if (!bookkeeping.rows[0]?.reg) {
    await applyMigration(client, file);
    return true;
  }
  const recorded = await client.query(
    'SELECT 1 FROM schema_migrations WHERE version = $1',
    [version]
  );
  if (recorded.rowCount) return false;
  await applyMigration(client, file);
  return true;
}

async function expectConstraint(client, text, values, constraint) {
  await assert.rejects(
    client.query(text, values),
    (error) => error?.code === '23514' && error?.constraint === constraint,
    `Expected CHECK constraint ${constraint}`
  );
}

async function expectUnique(client, text, values, constraint) {
  await assert.rejects(
    client.query(text, values),
    (error) => error?.code === '23505' && error?.constraint === constraint,
    `Expected UNIQUE constraint ${constraint}`
  );
}

async function expectForeignKey(client, text, values, constraint) {
  await assert.rejects(
    client.query(text, values),
    (error) => error?.code === '23503' && error?.constraint === constraint,
    `Expected FOREIGN KEY constraint ${constraint}`
  );
}

async function seedLegacyData(client) {
  const userResult = await client.query(`
    INSERT INTO users (name, email, password_salt, password_hash, share_id)
    VALUES ('Migration Tester', 'migration@example.test', 'salt', 'hash', 'migration-test-share')
    RETURNING id
  `);
  const userId = userResult.rows[0].id;

  await client.query(`
    INSERT INTO alerts (user_id, name, filters, channel_email, channel_text)
    VALUES
      ($1, 'Legacy happy hour alert', '{"neighborhood":"North Park"}'::jsonb, true, false),
      ($1, 'Legacy text alert', '{}'::jsonb, false, true)
  `, [userId]);

  await client.query(`
    INSERT INTO saved_spots (user_id, venue_id, status, note)
    VALUES ($1, 101, 'favorite', 'Saved is not followed')
  `, [userId]);

  await client.query(`
    INSERT INTO promotions (venue_id, deal_code, description, updated_at)
    VALUES
      (101, 'LEGACY101', 'A preserved legacy offer', '2026-08-13T04:34:04.901Z'),
      (202, 'LEGACY202', '', '2026-08-14T05:35:05.902Z')
  `);

  await client.query(`
    INSERT INTO live_overrides (venue_id, active, since, expires_at, updated_at)
    VALUES (101, true, '2026-08-13T04:33:02.715Z', '2030-08-13T08:33:02.715Z', '2026-08-13T04:33:02.715Z')
  `);

  await client.query(`
    INSERT INTO notification_log (user_id, venue_id, channel, sent_at)
    VALUES ($1, 101, 'email', '2026-08-13T04:40:00.000Z')
  `, [userId]);

  return userId;
}

async function verifyLegacyPreservation(client, before) {
  const promotions = normalized((await client.query(`
    SELECT venue_id, deal_code, description, updated_at
    FROM promotions ORDER BY venue_id
  `)).rows);
  const overrides = normalized((await client.query(`
    SELECT venue_id, active, since, expires_at, updated_at
    FROM live_overrides ORDER BY venue_id
  `)).rows);
  const log = normalized((await client.query(`
    SELECT user_id, venue_id, channel, sent_at
    FROM notification_log ORDER BY venue_id, channel
  `)).rows);

  assert.deepEqual(promotions, before.promotions, 'legacy promotions changed');
  assert.deepEqual(overrides, before.overrides, 'legacy live overrides changed');
  assert.deepEqual(log, before.log, 'legacy notification log changed');
}

async function verifyNewRelationshipsStartEmpty(client) {
  const follows = Number((await client.query('SELECT count(*) AS count FROM venue_follows')).rows[0].count);
  const events = Number((await client.query('SELECT count(*) AS count FROM notification_events')).rows[0].count);
  assert.equal(follows, 0, 'migration must not infer venue follows from saved spots');
  assert.equal(events, 0, 'migration must not invent notification events from legacy state');
}

async function verifyPromotionCampaigns(client, userId) {
  const activeIndex = await client.query(`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'promotion_campaigns_active_window_idx'
  `);
  assert.equal(activeIndex.rowCount, 1);
  assert.match(activeIndex.rows[0].indexdef, /\(venue_id, starts_at, ends_at\)/);

  const overlapExclusions = Number((await client.query(`
    SELECT count(*) AS count
    FROM pg_constraint
    WHERE conrelid = 'promotion_campaigns'::regclass
      AND contype = 'x'
  `)).rows[0].count);
  assert.equal(overlapExclusions, 0, 'Phase 1 must not add a promotion overlap exclusion');

  const imported = normalized((await client.query(`
    SELECT id, venue_id, type, title, description, deal_code,
           starts_at, ends_at, created_by_user_id, published_at, ended_at,
           cancelled_at, legacy_promotion_venue_id, created_at, updated_at
    FROM promotion_campaigns
    WHERE legacy_promotion_venue_id IS NOT NULL
    ORDER BY legacy_promotion_venue_id
  `)).rows);

  assert.equal(imported.length, 2);
  assert.match(imported[0].id, /^[0-9a-f-]{36}$/i);
  assert.notEqual(imported[0].id, imported[1].id);
  assert.deepEqual(imported.map((row) => ({
    venueId: row.venue_id,
    type: row.type,
    title: row.title,
    description: row.description,
    dealCode: row.deal_code,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdBy: row.created_by_user_id,
    publishedAt: row.published_at,
    endedAt: row.ended_at,
    cancelledAt: row.cancelled_at,
    legacyVenueId: row.legacy_promotion_venue_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })), [
    {
      venueId: 101,
      type: 'special_deal',
      title: null,
      description: 'A preserved legacy offer',
      dealCode: 'LEGACY101',
      startsAt: null,
      endsAt: null,
      createdBy: null,
      publishedAt: null,
      endedAt: null,
      cancelledAt: null,
      legacyVenueId: 101,
      createdAt: '2026-08-13T04:34:04.901Z',
      updatedAt: '2026-08-13T04:34:04.901Z',
    },
    {
      venueId: 202,
      type: 'special_deal',
      title: null,
      description: '',
      dealCode: 'LEGACY202',
      startsAt: null,
      endsAt: null,
      createdBy: null,
      publishedAt: null,
      endedAt: null,
      cancelledAt: null,
      legacyVenueId: 202,
      createdAt: '2026-08-14T05:35:05.902Z',
      updatedAt: '2026-08-14T05:35:05.902Z',
    },
  ]);

  await expectConstraint(client, `
    INSERT INTO promotion_campaigns (venue_id, title, starts_at)
    VALUES (303, 'One-sided time', '2026-08-21T20:00:00Z')
  `, [], 'promotion_campaigns_time_window');

  await expectConstraint(client, `
    INSERT INTO promotion_campaigns (venue_id, title, starts_at, ends_at)
    VALUES (303, 'Too long', '2026-08-21T20:00:00Z', '2026-08-22T20:00:01Z')
  `, [], 'promotion_campaigns_time_window');

  await expectConstraint(client, `
    INSERT INTO promotion_campaigns (venue_id, title, starts_at, ends_at, published_at)
    VALUES (303, '   ', '2026-08-21T20:00:00Z', '2026-08-21T22:00:00Z', '2026-08-20T20:00:00Z')
  `, [], 'promotion_campaigns_published_complete');

  await expectConstraint(client, `
    INSERT INTO promotion_campaigns (venue_id, title, ended_at)
    VALUES (303, 'Unpublished end', '2026-08-21T21:00:00Z')
  `, [], 'promotion_campaigns_terminal_published');

  await expectConstraint(client, `
    INSERT INTO promotion_campaigns (
      venue_id, title, starts_at, ends_at, published_at, ended_at, cancelled_at
    ) VALUES (
      303, 'Two terminal states', '2026-08-21T20:00:00Z', '2026-08-21T22:00:00Z',
      '2026-08-20T20:00:00Z', '2026-08-21T21:00:00Z', '2026-08-21T21:00:00Z'
    )
  `, [], 'promotion_campaigns_terminal_state');

  const published = await client.query(`
    INSERT INTO promotion_campaigns (
      venue_id, type, title, description, starts_at, ends_at,
      created_by_user_id, published_at
    ) VALUES (
      303, 'event', 'A valid campaign', 'Valid for exactly one day',
      '2026-08-21T20:00:00Z', '2026-08-22T20:00:00Z', $1,
      '2026-08-20T20:00:00Z'
    )
    RETURNING id
  `, [userId]);

  await expectUnique(client, `
    INSERT INTO promotion_campaigns (venue_id, legacy_promotion_venue_id)
    VALUES (404, 101)
  `, [], 'promotion_campaigns_legacy_promotion_venue_id_key');

  return published.rows[0].id;
}

async function verifyAlertKinds(client, userId) {
  const existing = (await client.query(`SELECT alert_kinds FROM alerts ORDER BY created_at, id`)).rows;
  assert.equal(existing.length, 2);
  assert.deepEqual(existing.map((row) => row.alert_kinds), [['happy_hour'], ['happy_hour']]);

  const inserted = await client.query(`
    INSERT INTO alerts (user_id, name)
    VALUES ($1, 'Default kind')
    RETURNING alert_kinds
  `, [userId]);
  assert.deepEqual(inserted.rows[0].alert_kinds, ['happy_hour']);

  await client.query(`
    INSERT INTO alerts (user_id, name, alert_kinds)
    VALUES ($1, 'Both kinds', ARRAY['happy_hour', 'promotion']::text[])
  `, [userId]);

  const promotionOnly = await client.query(`
    INSERT INTO alerts (user_id, name, alert_kinds)
    VALUES ($1, 'Promotion only', ARRAY['promotion']::text[])
    RETURNING alert_kinds
  `, [userId]);
  assert.deepEqual(promotionOnly.rows[0].alert_kinds, ['promotion']);

  await expectConstraint(client, `
    INSERT INTO alerts (user_id, name, alert_kinds)
    VALUES ($1, 'No kinds', ARRAY[]::text[])
  `, [userId], 'alerts_alert_kinds_valid');

  await expectConstraint(client, `
    INSERT INTO alerts (user_id, name, alert_kinds)
    VALUES ($1, 'Unsupported kind', ARRAY['boost']::text[])
  `, [userId], 'alerts_alert_kinds_valid');

  await expectConstraint(client, `
    INSERT INTO alerts (user_id, name, alert_kinds)
    VALUES ($1, 'Duplicate kind', ARRAY['promotion', 'promotion']::text[])
  `, [userId], 'alerts_alert_kinds_valid');

  await expectConstraint(client, `
    INSERT INTO alerts (user_id, name, alert_kinds)
    VALUES ($1, 'Noncanonical order', ARRAY['promotion', 'happy_hour']::text[])
  `, [userId], 'alerts_alert_kinds_valid');
}

async function verifyVenueFollows(client, userId) {
  const result = await client.query(`
    INSERT INTO venue_follows (user_id, venue_id)
    VALUES ($1, 101)
    RETURNING happy_hour_alerts_enabled, promotion_alerts_enabled,
              channel_email, channel_text
  `, [userId]);
  assert.deepEqual(result.rows[0], {
    happy_hour_alerts_enabled: false,
    promotion_alerts_enabled: true,
    channel_email: true,
    channel_text: false,
  });

  await expectUnique(client, `
    INSERT INTO venue_follows (user_id, venue_id)
    VALUES ($1, 101)
  `, [userId], 'venue_follows_pkey');

  const savedSpotCount = Number((await client.query(`SELECT count(*) AS count FROM saved_spots`)).rows[0].count);
  assert.equal(savedSpotCount, 1, 'creating a venue follow must not alter saved spots');
}

async function verifyNotificationFoundation(client, userId, promotionId) {
  const happyHourEvent = await client.query(`
    INSERT INTO notification_events (
      event_key, event_type, venue_id, available_at, expires_at
    ) VALUES (
      'hh:101:2026-08-21:16:00', 'happy_hour_started', 101,
      '2026-08-21T23:00:00Z', '2026-08-22T01:00:00Z'
    )
    RETURNING id
  `);
  const happyHourEventId = happyHourEvent.rows[0].id;

  await expectForeignKey(client, `
    INSERT INTO notification_events (
      event_key, event_type, venue_id, promotion_id, available_at, expires_at
    ) VALUES (
      'promotion:wrong-venue', 'promotion_started', 999, $1,
      '2026-08-21T20:00:00Z', '2026-08-22T20:00:00Z'
    )
  `, [promotionId], 'notification_events_promotion_venue_fk');

  const promotionEvent = await client.query(`
    INSERT INTO notification_events (
      event_key, event_type, venue_id, promotion_id, available_at, expires_at
    ) VALUES (
      $1, 'promotion_started', 303, $2,
      '2026-08-21T20:00:00Z', '2026-08-22T20:00:00Z'
    )
    RETURNING id
  `, [`promotion:${promotionId}`, promotionId]);

  await expectUnique(client, `
    INSERT INTO notification_events (
      event_key, event_type, venue_id, promotion_id, available_at, expires_at
    ) VALUES (
      'promotion:duplicate-event', 'promotion_started', 303, $1,
      '2026-08-21T20:00:00Z', '2026-08-22T20:00:00Z'
    )
  `, [promotionId], 'notification_events_promotion_started_unique');

  await expectConstraint(client, `
    INSERT INTO notification_events (
      event_key, event_type, venue_id, available_at, expires_at
    ) VALUES (
      'promotion:missing-subject', 'promotion_started', 303,
      '2026-08-21T20:00:00Z', '2026-08-21T21:00:00Z'
    )
  `, [], 'notification_events_subject');

  await expectConstraint(client, `
    INSERT INTO notification_events (
      event_key, event_type, venue_id, available_at, expires_at
    ) VALUES (
      '   ', 'happy_hour_started', 101,
      '2026-08-21T20:00:00Z', '2026-08-21T21:00:00Z'
    )
  `, [], 'notification_events_event_key_check');

  const pending = await client.query(`
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source
    ) VALUES ($1, $2, 'email', 'saved_alert')
    RETURNING status, attempt_count, sent_at, batch_id, last_error
  `, [happyHourEventId, userId]);
  assert.deepEqual(pending.rows[0], {
    status: 'pending',
    attempt_count: 0,
    sent_at: null,
    batch_id: null,
    last_error: null,
  });

  const independentText = await client.query(`
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source
    ) VALUES ($1, $2, 'text', 'organic_follow')
    RETURNING channel, status
  `, [happyHourEventId, userId]);
  assert.deepEqual(independentText.rows[0], { channel: 'text', status: 'pending' });

  const happyHourChannels = (await client.query(`
    SELECT channel
    FROM notification_deliveries
    WHERE event_id = $1 AND user_id = $2
    ORDER BY channel
  `, [happyHourEventId, userId])).rows.map((row) => row.channel);
  assert.deepEqual(happyHourChannels, ['email', 'text']);

  await expectUnique(client, `
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source
    ) VALUES ($1, $2, 'email', 'organic_follow')
  `, [happyHourEventId, userId], 'notification_deliveries_event_id_user_id_channel_key');

  await expectConstraint(client, `
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source, status, attempt_count
    ) VALUES ($1, $2, 'email', 'organic_follow', 'sending', 1)
  `, [promotionEvent.rows[0].id, userId], 'notification_deliveries_lease_state');

  await expectConstraint(client, `
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source, lease_expires_at
    ) VALUES ($1, $2, 'email', 'organic_follow', '2026-08-21T20:10:00Z')
  `, [promotionEvent.rows[0].id, userId], 'notification_deliveries_lease_state');

  await expectConstraint(client, `
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source, next_attempt_at
    ) VALUES ($1, $2, 'email', 'organic_follow', NULL)
  `, [promotionEvent.rows[0].id, userId], 'notification_deliveries_pending_schedule');

  await expectConstraint(client, `
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source,
      status, attempt_count, next_attempt_at
    ) VALUES ($1, $2, 'email', 'organic_follow', 'failed', 0, NULL)
  `, [promotionEvent.rows[0].id, userId], 'notification_deliveries_attempt_progress');

  await expectConstraint(client, `
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source,
      status, attempt_count, sent_at
    ) VALUES ($1, $2, 'text', 'organic_follow', 'sent', 1, '2026-08-21T20:05:00Z')
  `, [promotionEvent.rows[0].id, userId], 'notification_deliveries_sent_text_batch');

  await expectConstraint(client, `
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source, status, attempt_count
    ) VALUES ($1, $2, 'email', 'organic_follow', 'sent', 1)
  `, [promotionEvent.rows[0].id, userId], 'notification_deliveries_sent_timestamp');

  await client.query(`
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source,
      status, attempt_count, lease_expires_at
    ) VALUES (
      $1, $2, 'email', 'organic_follow', 'sending', 1,
      '2026-08-21T20:10:00Z'
    )
  `, [promotionEvent.rows[0].id, userId]);

  const batchId = crypto.randomUUID();
  await client.query(`
    INSERT INTO notification_deliveries (
      event_id, user_id, channel, distribution_source,
      status, attempt_count, batch_id, sent_at
    ) VALUES ($1, $2, 'text', 'organic_follow', 'sent', 1, $3, '2026-08-21T20:05:00Z')
  `, [promotionEvent.rows[0].id, userId, batchId]);
}

function safeErrorMessage(error, parsed, raw) {
  let message = String(error?.message || error || 'Unknown failure');
  message = message.replaceAll(raw, '[redacted TEST_DATABASE_URL]');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted database URL]');
  for (const secret of [parsed.username, parsed.password]) {
    if (secret && secret.length >= 4) message = message.replaceAll(secret, '[redacted]');
  }
  return message;
}

function buildRunFailure(primaryFailure, cleanupFailure, parsed, raw) {
  if (primaryFailure) {
    let message = safeErrorMessage(primaryFailure, parsed, raw);
    if (cleanupFailure) {
      message += ` Cleanup also failed: ${safeErrorMessage(cleanupFailure, parsed, raw)}`;
    }
    return new Error(message);
  }
  if (cleanupFailure) {
    return new Error(`Cleanup failed after successful checks: ${safeErrorMessage(cleanupFailure, parsed, raw)}`);
  }
  return null;
}

function runGuardOnlySelfTest() {
  const safeUrl = 'postgres://guard_user:guard-secret@127.0.0.1/sdhh_migration_test';
  const safeEnv = {
    TEST_DATABASE_URL: safeUrl,
    TEST_DATABASE_DISPOSABLE: '1',
  };

  const accepted = requireDisposableTestDatabase(safeEnv);
  assert.equal(accepted.raw, safeUrl);
  assert.throws(
    () => requireDisposableTestDatabase({ ...safeEnv, TEST_DATABASE_DISPOSABLE: '0' }),
    /TEST_DATABASE_DISPOSABLE=1/
  );
  assert.throws(
    () => requireDisposableTestDatabase({
      ...safeEnv,
      TEST_DATABASE_URL: `${safeUrl}?search_path=public`,
    }),
    /must not override options or search_path/
  );
  assert.throws(
    () => requireDisposableTestDatabase({
      ...safeEnv,
      TEST_DATABASE_URL: `${safeUrl}?options=-csearch_path%3Dpublic`,
    }),
    /must not override options or search_path/
  );
  assert.throws(
    () => requireDisposableTestDatabase({ ...safeEnv, DATABASE_URL: safeUrl }),
    /also configured as DATABASE_URL/
  );
  assert.throws(
    () => requireDisposableTestDatabase({
      ...safeEnv,
      DATABASE_URL_UNPOOLED: 'postgres://another_user:another-secret@127.0.0.1/sdhh_migration_test',
    }),
    /same database as DATABASE_URL_UNPOOLED/
  );
  assert.throws(
    () => requireDisposableTestDatabase({
      ...safeEnv,
      TEST_DATABASE_URL: 'postgres://guard_user:guard-secret@127.0.0.1/production',
    }),
    /unsafe system, default, or production-looking/
  );
  assert.throws(
    () => requireDisposableTestDatabase({
      ...safeEnv,
      TEST_DATABASE_URL: 'postgres://guard_user:guard-secret@127.0.0.1/sdhh',
    }),
    /distinct test\/disposable\/scratch\/tmp marker/
  );

  const redacted = safeErrorMessage(
    new Error(`Could not connect with ${safeUrl}; password guard-secret was rejected.`),
    accepted.parsed,
    accepted.raw
  );
  assert.doesNotMatch(redacted, /guard-secret/);
  assert.doesNotMatch(redacted, /postgres(?:ql)?:\/\//);

  const cleanupOnly = buildRunFailure(null, new Error(`cleanup ${safeUrl}`), accepted.parsed, accepted.raw);
  assert.match(cleanupOnly.message, /^Cleanup failed after successful checks:/);
  assert.doesNotMatch(cleanupOnly.message, /guard-secret|postgres(?:ql)?:\/\//);

  const primaryAndCleanup = buildRunFailure(
    new Error('primary assertion failed'),
    new Error(`cleanup ${safeUrl}`),
    accepted.parsed,
    accepted.raw
  );
  assert.match(primaryAndCleanup.message, /^primary assertion failed/);
  assert.match(primaryAndCleanup.message, /Cleanup also failed:/);
  assert.doesNotMatch(primaryAndCleanup.message, /guard-secret|postgres(?:ql)?:\/\//);
}

async function main() {
  const { raw, parsed } = requireDisposableTestDatabase();
  const schema = `sdhh_live_promotions_test_${Date.now().toString(36)}_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const quotedSchema = quoteIdentifier(schema);
  let client = null;
  let schemaCreated = false;
  let primaryFailure = null;
  let cleanupFailure = null;

  const recordCleanupFailure = (error) => {
    if (!cleanupFailure) cleanupFailure = error;
  };

  try {
    client = new Client({
      connectionString: raw,
      ssl: isLocalDatabase(parsed) ? false : { rejectUnauthorized: true },
    });
    await client.connect();
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    schemaCreated = true;
    await client.query(`SET search_path TO ${quotedSchema}, pg_catalog`);
    await client.query(`SET statement_timeout TO '30s'`);
    await client.query(`SET lock_timeout TO '5s'`);

    for (const file of MIGRATIONS.slice(0, -1)) {
      assert.equal(await applyMigrationUnlessRecorded(client, file), true);
    }
    const userId = await seedLegacyData(client);

    const legacyBefore = {
      promotions: normalized((await client.query(`
        SELECT venue_id, deal_code, description, updated_at
        FROM promotions ORDER BY venue_id
      `)).rows),
      overrides: normalized((await client.query(`
        SELECT venue_id, active, since, expires_at, updated_at
        FROM live_overrides ORDER BY venue_id
      `)).rows),
      log: normalized((await client.query(`
        SELECT user_id, venue_id, channel, sent_at
        FROM notification_log ORDER BY venue_id, channel
      `)).rows),
    };

    assert.equal(await applyMigrationUnlessRecorded(client, MIGRATIONS.at(-1)), true);
    await verifyNewRelationshipsStartEmpty(client);
    assert.equal(
      await applyMigrationUnlessRecorded(client, MIGRATIONS.at(-1)),
      false,
      'an already-recorded 0007 migration must be skipped'
    );
    const recorded0007 = Number((await client.query(`
      SELECT count(*) AS count
      FROM schema_migrations
      WHERE version = '0007_live_promotions_foundation'
    `)).rows[0].count);
    assert.equal(recorded0007, 1);
    await verifyLegacyPreservation(client, legacyBefore);
    const promotionId = await verifyPromotionCampaigns(client, userId);
    await verifyAlertKinds(client, userId);
    await verifyVenueFollows(client, userId);
    await verifyNotificationFoundation(client, userId, promotionId);
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (client && schemaCreated) {
      if (!schema.startsWith('sdhh_live_promotions_test_')) {
        recordCleanupFailure(new Error('Refusing to clean up an unexpected schema name.'));
      } else {
        try {
          await client.query('SET search_path TO pg_catalog');
        } catch (error) {
          recordCleanupFailure(error);
        }
        try {
          await client.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
        } catch (error) {
          recordCleanupFailure(error);
        }
      }
    }
    if (client) {
      try {
        await client.end();
      } catch (error) {
        recordCleanupFailure(error);
      }
    }
  }

  const runFailure = buildRunFailure(primaryFailure, cleanupFailure, parsed, raw);
  if (runFailure) throw runFailure;

  console.log('live promotions migration: all checks passed');
}

async function runSelectedMode() {
  if (process.argv.slice(2).includes('--guard-only')) {
    runGuardOnlySelfTest();
    console.log('live promotions migration guard: all checks passed (no database connection attempted)');
    return;
  }
  await main();
}

runSelectedMode().catch((error) => {
  // Do not print a stack here: database clients may attach connection details
  // to nested errors. main() has already redacted the useful message.
  console.error(`live promotions migration: ${error.message}`);
  process.exitCode = 1;
});
