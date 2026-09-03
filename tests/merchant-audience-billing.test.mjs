import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { formatPromotionPlanLabel } from '../src/lib/merchantBilling.ts';

const ROOT = process.cwd();

test('billing plan labels cover free, pro, and founding partner', () => {
  assert.equal(formatPromotionPlanLabel('free'), 'Free');
  assert.equal(formatPromotionPlanLabel('pro'), 'Pro');
  assert.equal(formatPromotionPlanLabel('founding_partner'), 'Founding Partner');
});

test('Audience and Billing pages, APIs, shell tabs, and event alert migration are wired', async () => {
  const [
    migration,
    audiencePage,
    billingPage,
    audienceApi,
    billingApi,
    audienceLib,
    billingLib,
    shell,
    reportsPage,
    reportingLib,
  ] = await Promise.all([
    readFile(path.join(ROOT, 'migrations/0023_venue_follow_event_alerts.sql'), 'utf8'),
    readFile(path.join(ROOT, 'src/pages/restaurant/audience.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src/pages/restaurant/billing.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src/pages/api/restaurant/audience.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src/pages/api/restaurant/billing.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src/lib/merchantAudience.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src/lib/merchantBilling.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src/components/MerchantShell.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src/pages/restaurant/reports.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src/lib/merchantReporting.ts'), 'utf8'),
  ]);

  assert.match(migration, /event_alerts_enabled/);
  assert.match(migration, /venue_follows_event_idx/);

  assert.match(audiencePage, /data-merchant-shell|MerchantShell/);
  assert.match(audiencePage, /activeTab="audience"/);
  assert.match(audiencePage, /getMerchantAudienceDetail|\/api\/restaurant\/audience/);
  assert.match(audiencePage, /drink-loader/);

  assert.match(billingPage, /activeTab="billing"/);
  assert.match(billingPage, /\/api\/restaurant\/billing/);
  assert.match(billingPage, /drink-loader/);
  assert.match(billingPage, /No charges this period/);

  assert.match(audienceApi, /getMerchantAudienceDetail/);
  assert.match(audienceApi, /paid_required/);
  assert.match(audienceApi, /listMerchantReportVenues/);

  assert.match(billingApi, /getMerchantBillingSummary/);
  assert.match(billingApi, /authorizeMerchantReport/);
  assert.match(billingApi, /requirePaid:\s*false/);

  assert.match(audienceLib, /export async function getMerchantAudienceDetail/);
  assert.match(audienceLib, /export async function getMerchantAudienceSnapshot/);
  assert.match(audienceLib, /Events coming soon/);
  assert.match(audienceLib, /event_alerts_enabled/);

  assert.match(billingLib, /export async function getMerchantBillingSummary/);
  assert.match(billingLib, /No charges this period/);
  assert.match(billingLib, /canRedeemAccessCode/);

  assert.match(shell, /id: 'audience'/);
  assert.match(shell, /id: 'billing'/);
  assert.match(shell, /max-width:\s*1240px/);

  assert.match(reportsPage, /See Audience/);
  assert.match(reportsPage, /\/restaurant\/audience\/\?venueId=/);
  assert.match(reportsPage, /data-merchant-shell-switcher/);
  assert.match(reportsPage, /shellSwitcher\?\.addEventListener\('change'/);

  assert.match(reportingLib, /from '\.\/merchantAudience'/);
  assert.match(reportingLib, /getMerchantAudienceSnapshot/);
});
