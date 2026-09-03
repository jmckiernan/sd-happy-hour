import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MERCHANT_TAB_CACHE_ACCOUNT_VENUE,
  MERCHANT_TAB_CACHE_TTL_MS,
  getMerchantTabCache,
  invalidateAllMerchantTabCache,
  invalidateMerchantTabCache,
  merchantTabCacheEqual,
  setMerchantTabCache,
  swrMerchantTabCache,
} from '../src/lib/merchantTabCache.ts';

test('merchant tab cache keys by venue + resource and supports SWR paint', async () => {
  invalidateAllMerchantTabCache();

  setMerchantTabCache(42, 'audience', { total: 10 });
  setMerchantTabCache(99, 'audience', { total: 99 });
  setMerchantTabCache(MERCHANT_TAB_CACHE_ACCOUNT_VENUE, 'claims', { claims: [{ id: 'a' }] });

  const hit = getMerchantTabCache(42, 'audience');
  assert.ok(hit);
  assert.equal(hit.data.total, 10);
  assert.equal(hit.stale, false);
  assert.ok(hit.cachedAt > 0);

  assert.equal(getMerchantTabCache(99, 'audience')?.data.total, 99);
  assert.notEqual(getMerchantTabCache(42, 'audience')?.data.total, 99);

  invalidateMerchantTabCache(42, 'audience');
  assert.equal(getMerchantTabCache(42, 'audience'), null);
  assert.ok(getMerchantTabCache(99, 'audience'));
  assert.ok(getMerchantTabCache(MERCHANT_TAB_CACHE_ACCOUNT_VENUE, 'claims'));

  invalidateMerchantTabCache(99);
  assert.equal(getMerchantTabCache(99, 'audience'), null);

  setMerchantTabCache(7, 'reports', { views: 1 }, { suffix: 'range=30d' });
  assert.ok(getMerchantTabCache(7, 'reports', { suffix: 'range=30d' }));
  assert.equal(getMerchantTabCache(7, 'reports', { suffix: 'range=7d' }), null);

  assert.equal(merchantTabCacheEqual({ a: 1 }, { a: 1 }), true);
  assert.equal(merchantTabCacheEqual({ a: 1 }, { a: 2 }), false);

  let paintedCached = false;
  let paintedFresh = false;
  setMerchantTabCache(3, 'billing', { plan: 'free' });
  const result = await swrMerchantTabCache({
    venueId: 3,
    resource: 'billing',
    fetcher: async () => ({ plan: 'pro' }),
    onCached: (data) => {
      paintedCached = data.plan === 'free';
    },
    onFresh: (data, meta) => {
      paintedFresh = data.plan === 'pro' && meta.changed === true && meta.fromCache === true;
    },
  });
  assert.equal(paintedCached, true);
  assert.equal(paintedFresh, true);
  assert.equal(result?.data.plan, 'pro');
  assert.equal(getMerchantTabCache(3, 'billing')?.data.plan, 'pro');

  assert.ok(MERCHANT_TAB_CACHE_TTL_MS >= 5 * 60 * 1000);
  assert.ok(MERCHANT_TAB_CACHE_TTL_MS <= 15 * 60 * 1000);

  invalidateAllMerchantTabCache();
  assert.equal(getMerchantTabCache(3, 'billing'), null);
  assert.equal(getMerchantTabCache(MERCHANT_TAB_CACHE_ACCOUNT_VENUE, 'claims'), null);
});

test('Audience/Billing/Promotions/Reports/Manage/Team wire merchantTabCache SWR', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = process.cwd();
  const files = await Promise.all([
    readFile(path.join(root, 'src/lib/merchantTabCache.ts'), 'utf8'),
    readFile(path.join(root, 'src/pages/restaurant/audience.astro'), 'utf8'),
    readFile(path.join(root, 'src/pages/restaurant/billing.astro'), 'utf8'),
    readFile(path.join(root, 'src/pages/restaurant/reports.astro'), 'utf8'),
    readFile(path.join(root, 'src/pages/restaurant.astro'), 'utf8'),
    readFile(path.join(root, 'src/pages/restaurant/manage/[slug].astro'), 'utf8'),
    readFile(path.join(root, 'src/pages/restaurant/manage/[slug]/users.astro'), 'utf8'),
  ]);
  const [helper, audience, billing, reports, promotions, manage, team] = files;

  assert.match(helper, /sessionStorage/);
  assert.match(helper, /stale-while-revalidate|swrMerchantTabCache/);
  assert.match(helper, /MERCHANT_TAB_CACHE_TTL_MS/);

  for (const page of [audience, billing, reports, promotions, manage, team]) {
    assert.match(page, /merchantTabCache/);
    assert.match(page, /swrMerchantTabCache|getMerchantTabCache/);
  }

  assert.match(audience, /resource:\s*'audience'/);
  assert.match(billing, /resource:\s*'billing'/);
  assert.match(reports, /resource:\s*'reports'/);
  assert.match(promotions, /resource:\s*'promotions'/);
  assert.match(promotions, /paintCachedDashboard|getMerchantTabCache/);
  assert.match(promotions, /invalidateAllMerchantTabCache/);
  assert.match(manage, /resource:\s*'listing'/);
  assert.match(manage, /resource:\s*'photos'/);
  assert.match(manage, /resource:\s*'menu'/);
  assert.match(manage, /ensurePanel/);
  assert.match(team, /resource:\s*'team'/);
});
