import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const ROOT = process.cwd();

function requireDisposableLocalDatabase(env = process.env) {
  if (env.TEST_DATABASE_DISPOSABLE !== '1') {
    throw new Error('TEST_DATABASE_DISPOSABLE=1 is required.');
  }
  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is required.');

  const parsed = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('TEST_DATABASE_URL must be a PostgreSQL URL.');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('Phase 2 integration tests require an explicitly disposable local PostgreSQL database.');
  }
  for (const [key] of parsed.searchParams) {
    if (['options', 'search_path'].includes(key.toLowerCase())) {
      throw new Error('TEST_DATABASE_URL must not override options or search_path.');
    }
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  if (!/(^|[-_])(test|testing|disposable|scratch|tmp)([-_]|$)/.test(databaseName)) {
    throw new Error('The disposable database name must contain a distinct test marker.');
  }
  for (const variable of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) {
    const other = env[variable]?.trim();
    if (other && other === raw) {
      throw new Error(`Refusing TEST_DATABASE_URL because it is also ${variable}.`);
    }
  }
  return { raw, parsed };
}

function connectionConfig(connectionString) {
  return { connectionString, ssl: false };
}

async function applyMigrations(client) {
  const files = (await readdir(path.join(ROOT, 'migrations')))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = await readFile(path.join(ROOT, 'migrations', file), 'utf8');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1)',
      [file.replace(/\.sql$/, '')]
    );
  }
}

async function seedUserAndClaim(client, { email, venueId, plan }) {
  const user = await client.query(`
    INSERT INTO users (name, email, password_salt, password_hash, share_id)
    VALUES ($1, $2, 'salt', 'hash', $3)
    RETURNING id
  `, ['Phase 2 Tester', email, crypto.randomUUID()]);
  const userId = user.rows[0].id;
  await client.query(`
    INSERT INTO venue_claims (
      user_id, venue_id, status, verification_method, plan
    ) VALUES ($1, $2, 'verified', 'manual', $3)
  `, [userId, venueId, plan]);
  return userId;
}

async function seedUser(client, email) {
  const user = await client.query(`
    INSERT INTO users (name, email, password_salt, password_hash, share_id)
    VALUES ($1, $2, 'salt', 'hash', $3)
    RETURNING id
  `, ['Phase 2 Consumer', email, crypto.randomUUID()]);
  return user.rows[0].id;
}

async function seedSession(client, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await client.query(`
    INSERT INTO sessions (id, role, user_id, expires_at)
    VALUES ($1, 'user', $2, now() + interval '1 hour')
  `, [token, userId]);
  return token;
}

function cookies(token = null) {
  return {
    get(name) {
      return name === 'sdhh_session' && token ? { value: token } : undefined;
    },
  };
}

function jsonRequest(url, method, body = {}) {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function futureWindow(year, month, day, startHour, endHour) {
  const pad = (value) => String(value).padStart(2, '0');
  return {
    startsAt: `${year}-${pad(month)}-${pad(day)}T${pad(startHour)}:00:00.000Z`,
    endsAt: `${year}-${pad(month)}-${pad(day)}T${pad(endHour)}:00:00.000Z`,
  };
}

async function main() {
  if (process.argv.includes('--guard-only')) {
    const sample = {
      TEST_DATABASE_DISPOSABLE: '1',
      TEST_DATABASE_URL: 'postgres://tester:secret@127.0.0.1/sdhh_phase2_test',
    };
    assert.equal(requireDisposableLocalDatabase(sample).parsed.hostname, '127.0.0.1');
    assert.throws(
      () => requireDisposableLocalDatabase({ ...sample, TEST_DATABASE_DISPOSABLE: '0' }),
      /TEST_DATABASE_DISPOSABLE=1/
    );
    assert.throws(
      () => requireDisposableLocalDatabase({ ...sample, TEST_DATABASE_URL: 'postgres://tester:secret@example.com/sdhh_phase2_test' }),
      /local PostgreSQL/
    );
    assert.throws(
      () => requireDisposableLocalDatabase({ ...sample, TEST_DATABASE_URL: 'postgres://tester:secret@127.0.0.1/production' }),
      /test marker/
    );
    console.log('phase2 postgres guard: all checks passed');
    return;
  }

  const { raw } = requireDisposableLocalDatabase();
  const schema = `sdhh_phase2_test_${Date.now().toString(36)}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const admin = new Client(connectionConfig(raw));
  await admin.connect();

  let failure;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await applyMigrations(admin);

    const paidUserId = await seedUserAndClaim(admin, {
      email: `phase2-paid-${crypto.randomUUID()}@example.test`,
      venueId: 1,
      plan: 'paid',
    });
    const freeUserId = await seedUserAndClaim(admin, {
      email: `phase2-free-${crypto.randomUUID()}@example.test`,
      venueId: 2,
      plan: 'free',
    });
    const consumerUserId = await seedUser(
      admin,
      `phase2-consumer-${crypto.randomUUID()}@example.test`
    );
    const adminWithoutClaimUserId = await seedUser(admin, 'jmckiernan86@gmail.com');
    const pendingUserId = await seedUser(
      admin,
      `phase2-pending-${crypto.randomUUID()}@example.test`
    );
    await admin.query(`
      INSERT INTO venue_claims (user_id, venue_id, status, verification_method, plan)
      VALUES ($1, 3, 'pending', NULL, 'paid')
    `, [pendingUserId]);
    const paidToken = await seedSession(admin, paidUserId);
    const consumerToken = await seedSession(admin, consumerUserId);
    const adminWithoutClaimToken = await seedSession(admin, adminWithoutClaimUserId);
    const pendingToken = await seedSession(admin, pendingUserId);

    const serviceUrl = new URL(raw);
    serviceUrl.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = serviceUrl.toString();
    delete process.env.DATABASE_URL_UNPOOLED;
    process.env.PROMOTION_FREE_MONTHLY_LIMIT = '1';
    process.env.PROMOTION_PRO_MONTHLY_LIMIT = 'unlimited';
    process.env.PROMOTION_FOUNDING_PARTNER_MONTHLY_LIMIT = 'unlimited';
    process.env.PROMOTION_FOUNDING_PARTNER_VENUE_IDS = '';

    const service = await import('../src/lib/promotionService.ts');

    await assert.rejects(
      service.createPromotionDraft(paidUserId, {
        venueId: 1,
        type: 'special_deal',
        title: 'Offsetless schedule',
        startsAt: '2030-01-10T18:00',
        endsAt: '2030-01-10T20:00',
      }),
      (error) => error?.status === 422 && /absolute timestamp/.test(error.message)
    );

    const overlapA = await service.createPromotionDraft(paidUserId, {
      venueId: 1,
      type: 'special_deal',
      title: 'Overlap A',
      ...futureWindow(2030, 1, 10, 18, 20),
    });
    const overlapB = await service.createPromotionDraft(paidUserId, {
      venueId: 1,
      type: 'event',
      title: 'Overlap B',
      ...futureWindow(2030, 1, 10, 19, 21),
    });

    const overlapRace = await Promise.allSettled([
      service.publishPromotion(paidUserId, overlapA.promotion.id),
      service.publishPromotion(paidUserId, overlapB.promotion.id),
    ]);
    assert.equal(overlapRace.filter((result) => result.status === 'fulfilled').length, 1);
    const overlapFailure = overlapRace.find((result) => result.status === 'rejected');
    assert.equal(overlapFailure.reason.code, 'promotion_overlap');

    const overlapWinner = overlapRace.find((result) => result.status === 'fulfilled').value;
    const event = await admin.query(`
      SELECT event_key, available_at, expires_at, cancelled_at
      FROM notification_events WHERE promotion_id = $1
    `, [overlapWinner.promotion.id]);
    assert.equal(event.rowCount, 1);
    assert.equal(event.rows[0].event_key, `promotion:${overlapWinner.promotion.id}`);
    assert.equal(event.rows[0].cancelled_at, null);

    await service.cancelPromotion(paidUserId, overlapWinner.promotion.id);
    const cancelledEvent = await admin.query(`
      SELECT cancelled_at FROM notification_events WHERE promotion_id = $1
    `, [overlapWinner.promotion.id]);
    assert.ok(cancelledEvent.rows[0].cancelled_at);

    const quotaA = await service.createPromotionDraft(freeUserId, {
      venueId: 2,
      type: 'special_deal',
      title: 'Quota A',
      ...futureWindow(2031, 2, 10, 18, 19),
    });
    const quotaB = await service.createPromotionDraft(freeUserId, {
      venueId: 2,
      type: 'event',
      title: 'Quota B',
      ...futureWindow(2031, 2, 11, 20, 21),
    });

    const quotaRace = await Promise.allSettled([
      service.publishPromotion(freeUserId, quotaA.promotion.id),
      service.publishPromotion(freeUserId, quotaB.promotion.id),
    ]);
    assert.equal(quotaRace.filter((result) => result.status === 'fulfilled').length, 1);
    const quotaFailure = quotaRace.find((result) => result.status === 'rejected');
    assert.equal(quotaFailure.reason.code, 'promotion_quota_exhausted');
    assert.equal(quotaFailure.reason.details.entitlement.reserved, 1);

    const quotaWinner = quotaRace.find((result) => result.status === 'fulfilled').value;
    await service.cancelPromotion(freeUserId, quotaWinner.promotion.id);

    const liveEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const liveDraft = await service.createPromotionDraft(freeUserId, {
      venueId: 2,
      type: 'special_deal',
      title: 'Start now then end',
      endsAt: liveEnd,
      startsAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    const live = await service.startPromotionNow(freeUserId, liveDraft.promotion.id, { endsAt: liveEnd });
    assert.equal(live.promotion.publishedAt !== null, true);
    assert.equal(live.entitlement.consumed, 1);
    const ended = await service.endPromotion(freeUserId, live.promotion.id);
    assert.equal(ended.entitlement.consumed, 1);
    assert.ok(ended.promotion.endedAt);

    await assert.rejects(
      service.deletePromotionDraft(freeUserId, ended.promotion.id),
      (error) => error?.code === 'invalid_transition'
    );

    const deliveryCount = Number((await admin.query('SELECT count(*) AS count FROM notification_deliveries')).rows[0].count);
    assert.equal(deliveryCount, 0);

    const collectionRoute = await import('../src/pages/api/restaurant/promotions/index.ts');
    const itemRoute = await import('../src/pages/api/restaurant/promotions/[id].ts');
    const publishRoute = await import('../src/pages/api/restaurant/promotions/[id]/publish.ts');
    const cancelRoute = await import('../src/pages/api/restaurant/promotions/[id]/cancel.ts');
    const liveRoute = await import('../src/pages/api/promotions/live.ts');
    const legacyPublicRoute = await import('../src/pages/api/promotions.ts');
    const legacyMerchantRoute = await import('../src/pages/api/restaurant/promotion.ts');

    const offsetlessApiResponse = await collectionRoute.POST({
      request: jsonRequest('http://test/api/restaurant/promotions', 'POST', {
        venueId: 1,
        type: 'special_deal',
        title: 'Offsetless API schedule',
        startsAt: '2032-04-10T17:30',
        endsAt: '2032-04-10T19:00',
      }),
      cookies: cookies(paidToken),
    });
    assert.equal(offsetlessApiResponse.status, 422);
    assert.match((await offsetlessApiResponse.json()).errors.join(' '), /absolute timestamp/);

    const pendingClaimResponse = await collectionRoute.POST({
      request: jsonRequest('http://test/api/restaurant/promotions', 'POST', {
        venueId: 3,
        type: 'special_deal',
        title: 'Pending claim cannot create this',
      }),
      cookies: cookies(pendingToken),
    });
    assert.equal(pendingClaimResponse.status, 403);

    const createApiResponse = await collectionRoute.POST({
      request: jsonRequest('http://test/api/restaurant/promotions', 'POST', {
        venueId: 1,
        type: 'event',
        title: 'API-scheduled event',
        description: 'A route-level contract test.',
        dealCode: 'ROUTE32',
        ...futureWindow(2032, 4, 10, 18, 20),
      }),
      cookies: cookies(paidToken),
    });
    assert.equal(createApiResponse.status, 201);
    const createdViaApi = await createApiResponse.json();
    assert.equal(createdViaApi.promotion.state, 'draft');
    assert.equal(createdViaApi.promotion.venueId, 1);
    assert.equal(typeof createdViaApi.serverNow, 'string');
    assert.ok(createdViaApi.entitlement);

    const replacementVenueResponse = await itemRoute.PATCH({
      params: { id: createdViaApi.promotion.id },
      request: jsonRequest('http://test/item', 'PATCH', { venueId: 2 }),
      cookies: cookies(paidToken),
    });
    assert.equal(replacementVenueResponse.status, 400);

    const adminMutationResponse = await itemRoute.PATCH({
      params: { id: createdViaApi.promotion.id },
      request: jsonRequest('http://test/item', 'PATCH', { title: 'Admin replacement' }),
      cookies: cookies(adminWithoutClaimToken),
    });
    assert.equal(adminMutationResponse.status, 403);
    assert.equal((await adminMutationResponse.json()).code, 'promotion_forbidden');

    const publishApiResponse = await publishRoute.POST({
      params: { id: createdViaApi.promotion.id },
      request: jsonRequest('http://test/publish', 'POST'),
      cookies: cookies(paidToken),
    });
    assert.equal(publishApiResponse.status, 200);
    assert.equal((await publishApiResponse.json()).promotion.state, 'scheduled');

    const collectionResponse = await collectionRoute.GET({
      url: new URL('http://test/api/restaurant/promotions?venueId=1'),
      cookies: cookies(paidToken),
    });
    const collection = await collectionResponse.json();
    assert.equal(collection.venueId, 1);
    assert.ok(collection.promotions.some((promotion) => promotion.id === createdViaApi.promotion.id));

    const cancelApiResponse = await cancelRoute.POST({
      params: { id: createdViaApi.promotion.id },
      request: jsonRequest('http://test/cancel', 'POST'),
      cookies: cookies(paidToken),
    });
    assert.equal(cancelApiResponse.status, 200);
    assert.equal((await cancelApiResponse.json()).promotion.state, 'cancelled');

    const legacyPutResponse = await legacyMerchantRoute.PUT({
      request: jsonRequest('http://test/api/restaurant/promotion', 'PUT', {
        venueId: 1,
        description: 'Legacy campaign adapter',
        dealCode: 'LEGACY32',
      }),
      cookies: cookies(paidToken),
    });
    assert.equal(legacyPutResponse.status, 200);
    assert.deepEqual(
      Object.keys(await legacyPutResponse.json()).sort(),
      ['dealCode', 'description', 'updatedAt']
    );
    assert.equal(
      Number((await admin.query('SELECT count(*) AS count FROM promotions')).rows[0].count),
      0
    );

    const livePrivateDraft = await service.createPromotionDraft(paidUserId, {
      venueId: 1,
      type: 'special_deal',
      title: 'Authenticated deal code isolation',
      description: 'Visible to every visitor.',
      dealCode: 'PRIVATE32',
      startsAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const livePrivate = await service.startPromotionNow(paidUserId, livePrivateDraft.promotion.id, {
      endsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    async function callLive(token = null) {
      const response = await liveRoute.GET({
        url: new URL('http://test/api/promotions/live?venueId=1'),
        cookies: cookies(token),
      });
      const body = await response.json();
      return { response, body, promotion: body.promotions[0] };
    }

    const anonymousLive = await callLive();
    const authenticatedLive = await callLive(consumerToken);
    const anonymousLiveAgain = await callLive();
    for (const result of [anonymousLive, authenticatedLive, anonymousLiveAgain]) {
      assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
      assert.equal(result.response.headers.get('vary'), 'Cookie');
      assert.equal(result.promotion.id, livePrivate.promotion.id);
      assert.equal(result.promotion.hasDealCode, true);
    }
    assert.equal(Object.hasOwn(anonymousLive.promotion, 'dealCode'), false);
    assert.equal(authenticatedLive.promotion.dealCode, 'PRIVATE32');
    assert.equal(Object.hasOwn(anonymousLiveAgain.promotion, 'dealCode'), false);
    for (const privateField of ['createdByUserId', 'publishedAt', 'legacyPromotionVenueId']) {
      assert.equal(Object.hasOwn(authenticatedLive.promotion, privateField), false);
    }

    async function callLegacyPublic(token = null) {
      const response = await legacyPublicRoute.GET({ cookies: cookies(token) });
      return { response, body: await response.json() };
    }
    const anonymousLegacy = await callLegacyPublic();
    const authenticatedLegacy = await callLegacyPublic(consumerToken);
    const anonymousLegacyAgain = await callLegacyPublic();
    for (const result of [anonymousLegacy, authenticatedLegacy, anonymousLegacyAgain]) {
      assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
      assert.equal(result.response.headers.get('vary'), 'Cookie');
      assert.equal(result.body[1].description, 'Visible to every visitor.');
    }
    assert.equal(Object.hasOwn(anonymousLegacy.body[1], 'dealCode'), false);
    assert.equal(authenticatedLegacy.body[1].dealCode, 'PRIVATE32');
    assert.equal(Object.hasOwn(anonymousLegacyAgain.body[1], 'dealCode'), false);

    const legacyDeleteResponse = await legacyMerchantRoute.DELETE({
      request: jsonRequest('http://test/api/restaurant/promotion', 'DELETE', { venueId: 1 }),
      cookies: cookies(paidToken),
    });
    assert.equal(legacyDeleteResponse.status, 200);
    assert.equal(
      Number((await admin.query(`
        SELECT count(*) AS count FROM promotion_campaigns
        WHERE legacy_promotion_venue_id = 1
      `)).rows[0].count),
      0
    );

    console.log('phase2 postgres: all checks passed');
  } catch (error) {
    failure = error;
  } finally {
    await admin.query('RESET search_path').catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }

  if (failure) throw failure;
}

main().then(
  () => process.exit(0),
  (error) => {
    const message = String(error?.stack || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted database URL]');
    console.error(message);
    process.exit(1);
  }
);
