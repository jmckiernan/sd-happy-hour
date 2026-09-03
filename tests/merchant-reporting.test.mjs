import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  mapMerchantReportSummary,
  merchantConversionRate,
  resolveMerchantReportRange,
} from '../src/lib/merchantReporting.ts';
import {
  captureMerchantEvent,
  deviceTypeFromUserAgent,
} from '../src/lib/merchantAnalytics.ts';
import { ensureMerchantAnalyticsIdentity } from '../src/lib/merchantAnalyticsIdentity.ts';
import {
  canAccessMerchantReports,
  generateMerchantAccessCode,
} from '../src/lib/merchantEntitlements.ts';
import {
  nextMerchantReportSendAt,
  saveMerchantReportSchedule,
} from '../src/lib/merchantReportSchedules.ts';
import { merchantReportCsv, merchantReportPdf } from '../src/lib/merchantReportExport.ts';

const ROOT = process.cwd();

test('report ranges support 7, 30, 90, and Pacific-calendar custom dates', () => {
  const now = new Date('2026-08-24T20:00:00.000Z');
  assert.equal(resolveMerchantReportRange({ preset: '7d', now }).days, 7);
  assert.equal(resolveMerchantReportRange({ preset: '30d', now }).days, 30);
  assert.equal(resolveMerchantReportRange({ preset: '90d', now }).days, 90);
  const custom = resolveMerchantReportRange({
    preset: 'custom', from: '2026-08-01', to: '2026-08-07', now,
  });
  assert.equal(custom.days, 7);
  assert.equal(custom.start, '2026-08-01T07:00:00.000Z');
  assert.equal(custom.end, '2026-08-08T07:00:00.000Z');
  assert.equal(custom.label, 'Aug 1, 2026 - Aug 7, 2026');
  assert.throws(
    () => resolveMerchantReportRange({ preset: 'custom', from: '2025-01-01', to: '2026-08-01', now }),
    /1 to 366 days/
  );
});

test('aggregation rates use unique visits, not total clicks or total page views', () => {
  assert.equal(merchantConversionRate(2, 8), 25);
  assert.equal(merchantConversionRate(0, 0), 0);
  const summary = mapMerchantReportSummary({
    total_views: '25', authenticated_views: '10', unauthenticated_views: '15',
    unique_users: '9', unique_visits: '8', website_clicks: '6', website_visits: '2',
    call_clicks: '4', call_visits: '1', directions_clicks: '5', directions_visits: '3',
    saves: '3', save_visits: '2', shares: '2', share_visits: '1', follows: '2',
    follow_visits: '1', alert_subscriptions: '1', promotion_views: '20',
    promotion_view_visits: '5', promotion_clicks: '7', promotion_click_visits: '2',
    campaigns_launched: '2',
  });
  assert.equal(summary.websiteRate, 25);
  assert.equal(summary.callRate, 12.5);
  assert.equal(summary.directionsRate, 37.5);
  assert.equal(summary.campaignEngagementRate, 40);
  assert.equal(summary.totalViews, summary.authenticatedViews + summary.unauthenticatedViews);
});

test('only owner, venue full-admin, and site-admin roles can open reports', () => {
  assert.equal(canAccessMerchantReports('owner'), true);
  assert.equal(canAccessMerchantReports('full_admin'), true);
  assert.equal(canAccessMerchantReports('site_admin'), true);
  assert.equal(canAccessMerchantReports('promotions'), false);
  assert.equal(canAccessMerchantReports(null), false);
});

test('anonymous analytics ids are opaque, stable, httpOnly, and visits slide for 30 minutes', () => {
  const values = new Map();
  const writes = [];
  const cookies = {
    get(name) { return values.has(name) ? { value: values.get(name) } : undefined; },
    set(name, value, options) { values.set(name, value); writes.push({ name, value, options }); },
  };
  const first = ensureMerchantAnalyticsIdentity(cookies, true);
  const second = ensureMerchantAnalyticsIdentity(cookies, true);
  assert.equal(first.visitorId, second.visitorId);
  assert.equal(first.visitId, second.visitId);
  assert.match(first.visitorId, /^[0-9a-f-]{36}$/i);
  assert.ok(writes.every((write) => write.options.httpOnly && write.options.sameSite === 'lax' && write.options.secure));
  assert.equal(writes.find((write) => write.name === 'sdhh_analytics_visit').options.maxAge, 1800);
});

test('event capture validates public identity and stores venue, owner, promotion, auth, and device context', async () => {
  const queries = [];
  const executor = async (strings, ...values) => {
    const query = strings.join('?');
    queries.push({ query, values });
    if (query.includes('FROM venue_claims c JOIN users')) {
      return [{ claim_id: 'claim-1', user_id: 'owner-1', name: 'Owner', email: 'owner@example.test', plan: 'paid' }];
    }
    return [];
  };
  await assert.rejects(
    () => captureMerchantEvent({ eventName: 'website_click', venueId: 1, executor }),
    /anonymous visitor id/
  );
  await captureMerchantEvent({
    eventName: 'promotion_click', venueId: 1, promotionId: 'promotion-1',
    userId: 'user-1', visitorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    visitId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', authenticated: true,
    source: 'venue_page', deviceType: 'mobile', properties: { placement: 'live_deal' }, executor,
  });
  const insert = queries.find((entry) => entry.query.includes('INSERT INTO merchant_analytics_events'));
  assert.ok(insert);
  assert.ok(insert.values.includes('promotion_click'));
  assert.ok(insert.values.includes('owner-1'));
  assert.ok(insert.values.includes('promotion-1'));
  assert.ok(insert.values.includes('mobile'));
  assert.equal(deviceTypeFromUserAgent('Mozilla/5.0 (iPhone; Mobile)'), 'mobile');
  assert.equal(deviceTypeFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X)'), 'desktop');
});

test('weekly and monthly report scheduling stays anchored to Pacific wall time', () => {
  const after = new Date('2026-10-31T18:00:00.000Z'); // Saturday before DST fallback
  const monday = nextMerchantReportSendAt({ frequency: 'weekly', dayOfWeek: 1, sendHourLocal: 8, after });
  assert.equal(monday.toISOString(), '2026-11-02T16:00:00.000Z');
  const monthly = nextMerchantReportSendAt({ frequency: 'monthly', dayOfMonth: 1, sendHourLocal: 8, after });
  assert.equal(monthly.toISOString(), '2026-11-01T16:00:00.000Z');
});

test('email report settings normalize the account email and persist schedule choices', async () => {
  let capturedValues = [];
  const executor = async (strings, ...values) => {
    capturedValues = values;
    return [{
      id: 'schedule-1', venue_id: 2, user_id: 'user-1', recipient_email: 'owner@example.test',
      frequency: 'weekly', day_of_week: 2, day_of_month: 1, send_hour_local: 9,
      enabled: true, next_send_at: '2026-08-25T16:00:00.000Z', last_sent_at: null,
    }];
  };
  const schedule = await saveMerchantReportSchedule({
    venueId: 2, userId: 'user-1', recipientEmail: ' Owner@Example.Test ',
    frequency: 'weekly', dayOfWeek: 2, sendHourLocal: 9,
  }, executor);
  assert.equal(schedule.recipientEmail, 'owner@example.test');
  assert.ok(capturedValues.includes('owner@example.test'));
  assert.equal(schedule.frequency, 'weekly');
  assert.equal(schedule.dayOfWeek, 2);
});

function sampleReport() {
  return {
    generatedAt: '2026-08-24T20:00:00.000Z',
    range: { preset: '30d', start: '2026-07-25T20:00:00.000Z', end: '2026-08-24T20:00:00.000Z', label: 'Last 30 days', days: 30 },
    venue: { id: 1, name: '=Example Restaurant', neighborhood: 'North Park' },
    summary: {
      totalViews: 230, authenticatedViews: 70, unauthenticatedViews: 160,
      uniqueUsers: 144, uniqueVisits: 175, websiteClicks: 42, callClicks: 18,
      directionsClicks: 55, saves: 23, shares: 12, follows: 19,
      alertSubscriptions: 17, promotionViews: 112, promotionClicks: 34,
      campaignsLaunched: 2, websiteRate: 20, callRate: 8, directionsRate: 25,
      saveRate: 10, shareRate: 5, followRate: 8, campaignEngagementRate: 30,
    },
    audience: { currentSavers: 88, currentFollowers: 61, currentAlertSubscribers: 47 },
    trend: Array.from({ length: 30 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, '0')}`,
      views: 3 + (index % 8), uniqueVisits: 2 + (index % 6), websiteClicks: index % 3,
      callClicks: index % 2, directionsClicks: index % 4, promotionClicks: index % 3,
    })),
    campaigns: [{ id: 'p1', title: '@Taco Tuesday', type: 'special_deal', state: 'ended', startsAt: '2026-08-01T23:00:00Z', endsAt: '2026-08-02T02:00:00Z', views: 90, clicks: 27, uniqueViewVisits: 71, uniqueClickVisits: 24, engagementRate: 33.8 }],
    comparison: [{ venueId: 1, venueName: '=Example Restaurant', uniqueVisits: 175, totalViews: 230, actions: 84, actionRate: 48 }],
    recentActivity: [],
    definitions: {
      uniqueVisits: 'Distinct 30-minute visits that viewed this venue page.',
      uniqueUsers: 'Signed-in users plus privacy-safe anonymous browser ids; no fingerprinting is used.',
      conversionRate: 'Distinct visits with the action divided by distinct visits that viewed the venue.',
      revenueProxy: 'Clicks are intent signals, not attributed revenue.',
    },
  };
}

test('CSV and PDF exports are complete, safe, and branded', async () => {
  const report = sampleReport();
  const csv = merchantReportCsv(report);
  assert.match(csv, /^\uFEFFHappy Hour SD Merchant Report/);
  assert.match(csv, /'=Example Restaurant/);
  assert.match(csv, /'@Taco Tuesday/);
  assert.match(csv, /Campaign performance/);
  const pdf = await merchantReportPdf({
    ...report,
    venue: { ...report.venue, name: 'Harbor & Vine' },
    campaigns: report.campaigns.map((campaign) => ({ ...campaign, title: 'Taco Tuesday' })),
    comparison: report.comparison.map((venue) => ({ ...venue, venueName: 'Harbor & Vine' })),
  });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 5_000);
});

test('migration, protected route, ownership isolation, venue switcher, exports, code generation, and cron are wired', async () => {
  const [migration, page, reportRoute, exportRoute, codeRoute, cron, netlify, reporting, entitlements] = await Promise.all([
    readFile(path.join(ROOT, 'migrations/0015_merchant_reporting.sql'), 'utf8'),
    readFile(path.join(ROOT, 'src/pages/restaurant/reports.astro'), 'utf8'),
    readFile(path.join(ROOT, 'src/pages/api/restaurant/reports/index.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src/pages/api/restaurant/reports/export.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src/pages/api/admin/merchant-access-codes.ts'), 'utf8'),
    readFile(path.join(ROOT, 'netlify/functions/dispatch-merchant-reports.mts'), 'utf8'),
    readFile(path.join(ROOT, 'netlify.toml'), 'utf8'),
    readFile(path.join(ROOT, 'src/lib/merchantReporting.ts'), 'utf8'),
    readFile(path.join(ROOT, 'src/lib/merchantEntitlements.ts'), 'utf8'),
  ]);
  for (const table of ['merchant_entitlements', 'merchant_access_codes', 'merchant_analytics_events', 'merchant_report_schedules', 'merchant_report_deliveries']) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /venue_owner_user_id/);
  assert.match(migration, /visitor_id/);
  assert.match(migration, /visit_id/);
  assert.match(page, /data-merchant-shell-switcher/);
  assert.match(page, /shellSwitcher\?\.addEventListener\('change'/);
  assert.match(page, /See Audience/);
  assert.match(page, /format=pdf/);
  assert.match(reportRoute, /listMerchantReportVenues/);
  assert.match(reportRoute, /paid_required/);
  assert.match(reportRoute, /ownerUserId: venue\.ownerUserId/);
  assert.match(reportRoute, /ownerUserId: _ownerUserId/);
  assert.match(reporting, /venue_owner_user_id = \$\{ownerUserId\}/);
  assert.match(reporting, /access\.owner_user_id = e\.venue_owner_user_id/);
  assert.match(entitlements, /LEAST\(merchant_entitlements\.access_starts_at, EXCLUDED\.access_starts_at\)/);
  assert.match(exportRoute, /authorizeMerchantReport/);
  assert.match(codeRoute, /getAdminUser/);
  assert.match(cron, /runMerchantReportDispatch/);
  assert.match(netlify, /dispatch-merchant-reports/);
  assert.match(generateMerchantAccessCode(), /^SDHH-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});

if (process.argv.includes('--write-sample')) {
  const outputDirectory = path.join(ROOT, 'output', 'pdf');
  await mkdir(outputDirectory, { recursive: true });
  const report = sampleReport();
  await writeFile(path.join(outputDirectory, 'merchant-report-sample.pdf'), await merchantReportPdf({
    ...report,
    venue: { ...report.venue, name: 'Harbor & Vine' },
    campaigns: report.campaigns.map((campaign) => ({ ...campaign, title: 'Taco Tuesday' })),
    comparison: report.comparison.map((venue) => ({ ...venue, venueName: 'Harbor & Vine' })),
  }));
}
