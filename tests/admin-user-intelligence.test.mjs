import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  accountMutationDecision,
  averageSessionSeconds,
  normalizeReportingDays,
  requiresOwnershipTransfer,
} from '../src/lib/adminUserPolicy.ts';
import {
  marketAreaForCoordinates,
  marketAreaLabel,
} from '../src/lib/marketAreas.ts';
import {
  GET as getAdminUser,
  PATCH as patchAdminUser,
} from '../src/pages/api/admin/users/[id].ts';

const ROOT = process.cwd();

function subject(id, email, accountStatus = 'active') {
  return { id, email, accountStatus };
}

async function responseJson(response) {
  return { status: response.status, body: await response.json() };
}

test('account mutation policy protects the acting and site-admin accounts', () => {
  const actor = subject('admin-1', 'first@example.test');
  const adminEmails = ['first@example.test', 'second@example.test'];
  assert.equal(accountMutationDecision({ actor, target: actor, action: 'deactivate', adminEmails }), 'self');
  assert.equal(accountMutationDecision({
    actor,
    target: subject('admin-2', 'SECOND@example.test'),
    action: 'anonymize',
    adminEmails,
  }), 'protected_admin');
  assert.equal(accountMutationDecision({
    actor,
    target: subject('user-1', 'user@example.test'),
    action: 'deactivate',
    adminEmails,
  }), 'allowed');
});

test('account state transitions and dependency transfer rules are explicit', () => {
  const actor = subject('admin', 'admin@example.test');
  const adminEmails = ['admin@example.test'];
  assert.equal(accountMutationDecision({
    actor, target: subject('user', 'user@example.test', 'inactive'), action: 'deactivate', adminEmails,
  }), 'invalid_transition');
  assert.equal(accountMutationDecision({
    actor, target: subject('user', 'user@example.test', 'active'), action: 'reactivate', adminEmails,
  }), 'invalid_transition');
  assert.equal(accountMutationDecision({
    actor, target: subject('user', 'deleted@example.test', 'anonymized'), action: 'reactivate', adminEmails,
  }), 'already_anonymized');
  assert.equal(requiresOwnershipTransfer({ verifiedVenueClaims: 1, customOwnedLists: 0 }), true);
  assert.equal(requiresOwnershipTransfer({ verifiedVenueClaims: 0, customOwnedLists: 1 }), true);
  assert.equal(requiresOwnershipTransfer({ verifiedVenueClaims: 0, customOwnedLists: 0 }), false);
});

test('reporting helpers keep session metrics bounded and consistent', () => {
  assert.equal(averageSessionSeconds(600, 4), 150);
  assert.equal(averageSessionSeconds(600, 0), 0);
  assert.equal(normalizeReportingDays(7), 7);
  assert.equal(normalizeReportingDays('90'), 90);
  assert.equal(normalizeReportingDays(365), 30);
});

test('coordinates collapse into broad labels without returning the source point', () => {
  const urban = marketAreaForCoordinates(32.735, -117.16);
  const coastalNorth = marketAreaForCoordinates(33.12, -117.31);
  const outside = marketAreaForCoordinates(40.71, -74.0);
  assert.equal(urban, 'urban_core');
  assert.equal(coastalNorth, 'coastal_north');
  assert.equal(outside, 'outside_market');
  assert.equal(marketAreaLabel(urban), 'Urban Core');
  assert.equal(typeof urban, 'string');
});

test('admin user detail and mutation APIs require a super admin and enrich venues', async () => {
  globalThis.__adminUserApiFixture = { authenticated: false, calls: [] };
  let result = await responseJson(await getAdminUser({ params: { id: 'user-1' }, cookies: {} }));
  assert.equal(result.status, 401);

  globalThis.__adminUserApiFixture.authenticated = true;
  globalThis.__adminUserApiFixture.detail = {
    user: { id: 'user-1' },
    claims: [{ venue_id: 2 }],
    managers: [{ venue_id: 3 }],
  };
  result = await responseJson(await getAdminUser({ params: { id: 'user-1' }, cookies: {} }));
  assert.equal(result.status, 200);
  assert.equal(result.body.claims[0].venueName, 'Test Venue Two');
  assert.equal(result.body.managers[0].venueName, 'Venue #3');

  result = await responseJson(await patchAdminUser({
    params: { id: 'user-1' }, cookies: {},
    request: new Request('https://example.test/api/admin/users/user-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'erase' }),
    }),
  }));
  assert.equal(result.status, 422);

  result = await responseJson(await patchAdminUser({
    params: { id: 'user-1' }, cookies: {},
    request: new Request('https://example.test/api/admin/users/user-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'anonymize', transferToEmail: 'recipient@example.test' }),
    }),
  }));
  assert.equal(result.status, 200);
  assert.equal(globalThis.__adminUserApiFixture.calls[0].action, 'anonymize');
  assert.equal(globalThis.__adminUserApiFixture.calls[0].transferToEmail, 'recipient@example.test');
  delete globalThis.__adminUserApiFixture;
});

test('migration, UI, and auth gates contain the scalable reporting foundation', async () => {
  const [migration, page, store, login, analytics] = await Promise.all([
    readFile(path.join(ROOT, 'migrations', '0014_admin_user_intelligence.sql'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'admin', 'users.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'lib', 'store.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'pages', 'api', 'account', 'login.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src', 'lib', 'productAnalytics.ts'), 'utf8'),
  ]);
  for (const table of [
    'user_activity_sessions', 'user_engagement_daily', 'user_notification_daily_metrics',
    'user_area_activity_daily', 'product_analytics_events', 'admin_user_actions',
  ]) assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  assert.match(migration, /account_status IN \('active', 'inactive', 'anonymized'\)/);
  assert.doesNotMatch(migration, /latitude\s+(numeric|real|double|decimal)/i);
  assert.doesNotMatch(migration, /longitude\s+(numeric|real|double|decimal)/i);
  assert.match(page, /cursor/);
  assert.match(page, /Delete &amp; anonymize/);
  assert.match(page, /Merchant reporting will require at least 20 active users/);
  assert.match(store, /users\.account_status = 'active'/);
  assert.match(login, /user\.accountStatus !== 'active'/);
  assert.match(analytics, /EVENT_PROPERTIES/);
  assert.doesNotMatch(analytics, /properties:\s*\{[^}]*email/si);
});

