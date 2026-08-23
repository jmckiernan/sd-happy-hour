import assert from 'node:assert/strict';

import {
  SD_TIME_ZONE,
  getActiveHappyHourOccurrence,
  getHappyHourOccurrenceForDate,
  getSanDiegoDayBounds,
  getSanDiegoMonthKey,
  getSanDiegoParts,
  isHappyHourActive,
  parseInstant,
  parseSanDiegoLocalDateTime,
} from '../src/lib/sanDiegoTime.ts';
import {
  MAX_OVERLAPPING_PROMOTIONS_PER_VENUE,
  PROMOTION_STATES,
  PROMOTION_TYPES,
  findPromotionWindowConflict,
  getEffectivePromotionEnd,
  getPromotionState,
  isPromotionLive,
  promotionWindowsOverlap,
} from '../src/lib/promotionState.ts';
import {
  getMonthlyPromotionUsage,
  getPromotionAllowances,
  getPromotionEntitlement,
  parseFoundingPartnerVenueIds,
  resolvePromotionPlan,
} from '../src/lib/promotionEntitlements.ts';
import { getHappyHourEventKey, getPromotionEventKey } from '../src/lib/notificationEvents.ts';
import {
  ALERT_KINDS,
  MAX_PROMOTION_DURATION_MS,
  PROMOTION_DEAL_CODE_MAX_LENGTH,
  PROMOTION_DESCRIPTION_MAX_LENGTH,
  PROMOTION_TITLE_MAX_LENGTH,
  cleanAlertKinds,
  validateAlertKinds,
  validatePromotionInput,
} from '../src/lib/validation.ts';
import { isHappeningNow } from '../src/lib/venues.ts';

let failures = 0;
function test(name, run) {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

function iso(value) {
  return value?.toISOString() ?? null;
}

const EMPTY_ENV = {};

// ---------------------------------------------------------------------------
// San Diego wall-clock conversion and recurring happy-hour state
// ---------------------------------------------------------------------------

test('uses the canonical San Diego timezone', () => {
  assert.equal(SD_TIME_ZONE, 'America/Los_Angeles');
});

test('parses winter 17:00 Pacific as 01:00Z the next day', () => {
  assert.equal(iso(parseSanDiegoLocalDateTime('2026-01-15T17:00')), '2026-01-16T01:00:00.000Z');
});

test('parses summer 17:00 Pacific as 00:00Z the next day', () => {
  assert.equal(iso(parseSanDiegoLocalDateTime('2026-07-15T17:00')), '2026-07-16T00:00:00.000Z');
});

test('never parses an offsetless absolute string through the machine timezone', () => {
  assert.equal(parseInstant('2026-08-21T17:00'), null);
  assert.equal(iso(parseInstant('2026-08-21T17:00:00-07:00')), '2026-08-22T00:00:00.000Z');
});

test('handles Pacific midnight weekday/date rollover', () => {
  assert.deepEqual(getSanDiegoParts(new Date('2026-01-01T07:59:00Z')), {
    year: 2025,
    month: 12,
    day: 31,
    weekday: 'Wednesday',
    hour: 23,
    minute: 59,
    second: 0,
  });
  assert.deepEqual(getSanDiegoParts(new Date('2026-01-01T08:00:00Z')), {
    year: 2026,
    month: 1,
    day: 1,
    weekday: 'Thursday',
    hour: 0,
    minute: 0,
    second: 0,
  });
  assert.equal(getSanDiegoMonthKey(new Date('2026-01-01T07:59:00Z')), '2025-12');
});

test('rejects the nonexistent spring-forward wall time', () => {
  assert.equal(parseSanDiegoLocalDateTime('2026-03-08T02:30'), null);
});

test('rejects ambiguous fall-back input by default and supports explicit disambiguation', () => {
  assert.equal(parseSanDiegoLocalDateTime('2026-11-01T01:30'), null);
  assert.equal(
    iso(parseSanDiegoLocalDateTime('2026-11-01T01:30', { disambiguation: 'earlier' })),
    '2026-11-01T08:30:00.000Z'
  );
  assert.equal(
    iso(parseSanDiegoLocalDateTime('2026-11-01T01:30', { disambiguation: 'later' })),
    '2026-11-01T09:30:00.000Z'
  );
});

test('San Diego day bounds honor 23-hour and 25-hour DST days', () => {
  const spring = getSanDiegoDayBounds('2026-03-08');
  assert.equal(iso(spring.start), '2026-03-08T08:00:00.000Z');
  assert.equal(iso(spring.end), '2026-03-09T07:00:00.000Z');
  assert.equal(spring.end - spring.start, 23 * 60 * 60 * 1000);

  const fall = getSanDiegoDayBounds('2026-11-01');
  assert.equal(iso(fall.start), '2026-11-01T07:00:00.000Z');
  assert.equal(iso(fall.end), '2026-11-02T08:00:00.000Z');
  assert.equal(fall.end - fall.start, 25 * 60 * 60 * 1000);
});

const fridayHappyHour = {
  id: 7,
  days: ['Friday'],
  startTime: '16:00',
  endTime: '18:00',
};

test('happy hour is inactive before start, active at start/during, and inactive at exact end', () => {
  assert.equal(isHappyHourActive(fridayHappyHour, new Date('2026-08-21T22:59:59Z')), false);
  assert.equal(isHappyHourActive(fridayHappyHour, new Date('2026-08-21T23:00:00Z')), true);
  assert.equal(isHappyHourActive(fridayHappyHour, new Date('2026-08-22T00:15:00Z')), true);
  assert.equal(isHappyHourActive(fridayHappyHour, new Date('2026-08-22T01:00:00Z')), false);
  assert.equal(isHappeningNow(fridayHappyHour, new Date('2026-08-22T01:00:00Z')), false);
});

test('active happy-hour occurrence carries the Pacific date and absolute window', () => {
  const occurrence = getActiveHappyHourOccurrence(fridayHappyHour, new Date('2026-08-21T23:00:00Z'));
  assert.ok(occurrence);
  assert.equal(occurrence.dateKey, '2026-08-21');
  assert.equal(occurrence.weekday, 'Friday');
  assert.equal(iso(occurrence.startsAt), '2026-08-21T23:00:00.000Z');
  assert.equal(iso(occurrence.endsAt), '2026-08-22T01:00:00.000Z');
});

test('happy hour is inactive on a different day', () => {
  assert.equal(isHappyHourActive(fridayHappyHour, new Date('2026-08-20T23:30:00Z')), false);
});

test('MVP recurring schedules reject equal or overnight windows', () => {
  assert.equal(
    getHappyHourOccurrenceForDate({ ...fridayHappyHour, startTime: '18:00', endTime: '18:00' }, '2026-08-21'),
    null
  );
  assert.equal(
    getHappyHourOccurrenceForDate({ ...fridayHappyHour, startTime: '22:00', endTime: '02:00' }, '2026-08-21'),
    null
  );
});

test('happy-hour occurrence respects the spring DST offset change', () => {
  const occurrence = getHappyHourOccurrenceForDate(
    { id: 9, days: ['Sunday'], startTime: '01:00', endTime: '03:30' },
    '2026-03-08'
  );
  assert.ok(occurrence);
  assert.equal(iso(occurrence.startsAt), '2026-03-08T09:00:00.000Z');
  assert.equal(iso(occurrence.endsAt), '2026-03-08T10:30:00.000Z');
});

// ---------------------------------------------------------------------------
// Promotion lifecycle and overlap
// ---------------------------------------------------------------------------

const publishedWindow = {
  id: 'promo-a',
  publishedAt: '2026-08-20T20:00:00Z',
  startsAt: '2026-08-21T23:00:00Z',
  endsAt: '2026-08-22T01:00:00Z',
  endedAt: null,
  cancelledAt: null,
};

test('promotion constants expose the approved extensible MVP values', () => {
  assert.deepEqual([...PROMOTION_TYPES], ['special_deal', 'extended_happy_hour', 'event', 'other']);
  assert.deepEqual([...PROMOTION_STATES], ['draft', 'scheduled', 'live', 'ended', 'cancelled']);
  assert.equal(MAX_OVERLAPPING_PROMOTIONS_PER_VENUE, 1);
});

test('promotion state covers draft, scheduled, exact start, live, exact end, and ended', () => {
  assert.equal(getPromotionState({ ...publishedWindow, publishedAt: null }, '2026-08-21T23:30:00Z'), 'draft');
  assert.equal(getPromotionState(publishedWindow, '2026-08-21T22:59:59Z'), 'scheduled');
  assert.equal(getPromotionState(publishedWindow, '2026-08-21T23:00:00Z'), 'live');
  assert.equal(getPromotionState(publishedWindow, '2026-08-22T00:59:59Z'), 'live');
  assert.equal(getPromotionState(publishedWindow, '2026-08-22T01:00:00Z'), 'ended');
  assert.equal(getPromotionState(publishedWindow, '2026-08-22T02:00:00Z'), 'ended');
  assert.equal(isPromotionLive(publishedWindow, '2026-08-22T01:00:00Z'), false);
});

test('cancellation has precedence, including for an unpublished draft', () => {
  const cancelledAt = '2026-08-21T22:00:00Z';
  assert.equal(getPromotionState({ ...publishedWindow, cancelledAt }, '2026-08-21T23:30:00Z'), 'cancelled');
  assert.equal(
    getPromotionState({ ...publishedWindow, publishedAt: null, cancelledAt }, '2026-08-21T23:30:00Z'),
    'cancelled'
  );
});

test('manual end shortens the effective half-open window', () => {
  const ended = { ...publishedWindow, endedAt: '2026-08-22T00:00:00Z' };
  assert.equal(iso(getEffectivePromotionEnd(ended)), '2026-08-22T00:00:00.000Z');
  assert.equal(getPromotionState(ended, '2026-08-21T23:59:59Z'), 'live');
  assert.equal(getPromotionState(ended, '2026-08-22T00:00:00Z'), 'ended');
});

test('ending exactly at the start remains ended history rather than reverting to draft', () => {
  const endedAtStart = { ...publishedWindow, endedAt: publishedWindow.startsAt };
  assert.equal(getPromotionState(endedAtStart, publishedWindow.startsAt), 'ended');
});

test('offsetless persisted lifecycle strings never become live accidentally', () => {
  assert.equal(getPromotionState({ ...publishedWindow, publishedAt: '2026-08-20T20:00' }, '2026-08-21T23:30:00Z'), 'draft');
});

test('published promotion windows overlap only under the half-open rule', () => {
  const left = {
    id: 'left',
    publishedAt: '2026-08-01T00:00:00Z',
    startsAt: '2026-08-21T10:00:00Z',
    endsAt: '2026-08-21T12:00:00Z',
  };
  const overlaps = {
    id: 'overlap',
    publishedAt: '2026-08-01T00:00:00Z',
    startsAt: '2026-08-21T11:00:00Z',
    endsAt: '2026-08-21T13:00:00Z',
  };
  const adjacent = {
    id: 'adjacent',
    publishedAt: '2026-08-01T00:00:00Z',
    startsAt: '2026-08-21T12:00:00Z',
    endsAt: '2026-08-21T13:00:00Z',
  };
  assert.equal(promotionWindowsOverlap(left, overlaps), true);
  assert.equal(promotionWindowsOverlap(left, adjacent), false);
  assert.equal(promotionWindowsOverlap(left, { ...overlaps, publishedAt: null }), false);
  assert.equal(promotionWindowsOverlap(left, { ...overlaps, cancelledAt: '2026-08-01T01:00:00Z' }), false);
  assert.equal(findPromotionWindowConflict(left, [left, adjacent, overlaps]), overlaps);
});

// ---------------------------------------------------------------------------
// Configuration-driven entitlements and monthly usage
// ---------------------------------------------------------------------------

test('legacy paid maps to pro and configured venue ids map to founding partner', () => {
  assert.equal(resolvePromotionPlan('paid', { env: EMPTY_ENV }), 'pro');
  assert.equal(resolvePromotionPlan('pro', { env: EMPTY_ENV }), 'pro');
  assert.equal(resolvePromotionPlan('unknown', { env: EMPTY_ENV }), 'free');
  assert.equal(
    resolvePromotionPlan(
      { plan: 'free', venueId: 42 },
      { env: { PROMOTION_FOUNDING_PARTNER_VENUE_IDS: '7,42,108' } }
    ),
    'founding_partner'
  );
  // A UI/request boolean is not the runtime source of founding status.
  assert.equal(resolvePromotionPlan({ plan: 'free', venueId: 8, foundingPartner: true }, { env: EMPTY_ENV }), 'free');
});

test('founding-partner venue configuration validates positive integer ids', () => {
  assert.deepEqual([...parseFoundingPartnerVenueIds('7, 42,7')], [7, 42]);
  assert.throws(() => parseFoundingPartnerVenueIds('7,0'), /positive integer venue ids/);
  assert.throws(() => parseFoundingPartnerVenueIds('7,1.5'), /positive integer venue ids/);
});

test('all three monthly limits are independently configurable', () => {
  const env = {
    PROMOTION_FREE_MONTHLY_LIMIT: '2',
    PROMOTION_PRO_MONTHLY_LIMIT: '3',
    PROMOTION_FOUNDING_PARTNER_MONTHLY_LIMIT: '4',
  };
  assert.deepEqual(getPromotionAllowances({ env }), { free: 2, pro: 3, founding_partner: 4 });
  assert.equal(getPromotionEntitlement({ plan: 'free', consumed: 1, env, now: '2026-08-21T20:00:00Z' }).allowance, 2);
  assert.equal(getPromotionEntitlement({ plan: 'pro', consumed: 1, env, now: '2026-08-21T20:00:00Z' }).allowance, 3);
  assert.equal(
    getPromotionEntitlement({
      plan: 'free',
      venueId: 42,
      consumed: 1,
      env: { ...env, PROMOTION_FOUNDING_PARTNER_VENUE_IDS: '42' },
      now: '2026-08-21T20:00:00Z',
    }).allowance,
    4
  );
});

test('injected numeric allowances use the same independent positive-integer rules', () => {
  assert.deepEqual(
    getPromotionAllowances({ allowances: { free: 5, pro: 6, founding_partner: 7 }, env: EMPTY_ENV }),
    { free: 5, pro: 6, founding_partner: 7 }
  );

  for (const plan of ['free', 'pro', 'founding_partner']) {
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => getPromotionAllowances({ allowances: { [plan]: invalid }, env: EMPTY_ENV }),
        /positive integer or "unlimited"/
      );
    }
  }
});

test('default allowances are config defaults and unlimited serializes as null', () => {
  assert.deepEqual(getPromotionAllowances({ env: EMPTY_ENV }), {
    free: 1,
    pro: null,
    founding_partner: null,
  });
  const entitlement = getPromotionEntitlement({
    plan: 'pro',
    consumed: 100,
    reserved: 50,
    env: EMPTY_ENV,
    now: '2026-08-21T20:00:00Z',
  });
  assert.equal(entitlement.allowance, null);
  assert.equal(entitlement.remainingThisMonth, null);
  assert.equal(entitlement.canLaunchPromotion, true);
  assert.equal(JSON.parse(JSON.stringify(entitlement)).allowance, null);
});

test('unlimited is configurable independently for every plan', () => {
  const allowances = getPromotionAllowances({
    env: {
      PROMOTION_FREE_MONTHLY_LIMIT: 'unlimited',
      PROMOTION_PRO_MONTHLY_LIMIT: 'unlimited',
      PROMOTION_FOUNDING_PARTNER_MONTHLY_LIMIT: 'unlimited',
    },
  });
  assert.deepEqual(allowances, { free: null, pro: null, founding_partner: null });

  for (const plan of ['free', 'pro', 'founding_partner']) {
    const entitlement = getPromotionEntitlement({
      plan,
      consumed: 100,
      reserved: 50,
      allowances,
      env: EMPTY_ENV,
      now: '2026-08-21T20:00:00Z',
    });
    assert.equal(entitlement.allowance, null);
    assert.equal(entitlement.canLaunchPromotion, true);
  }
});

test('zero, negative, decimal, and malformed limits are invalid for every plan', () => {
  const keys = [
    'PROMOTION_FREE_MONTHLY_LIMIT',
    'PROMOTION_PRO_MONTHLY_LIMIT',
    'PROMOTION_FOUNDING_PARTNER_MONTHLY_LIMIT',
  ];
  for (const key of keys) {
    for (const invalid of ['0', '-1', '1.5', 'nope']) {
      const env = {
        PROMOTION_FREE_MONTHLY_LIMIT: '1',
        PROMOTION_PRO_MONTHLY_LIMIT: 'unlimited',
        PROMOTION_FOUNDING_PARTNER_MONTHLY_LIMIT: 'unlimited',
        [key]: invalid,
      };
      assert.throws(() => getPromotionAllowances({ env }), /positive integer or "unlimited"/);
    }
  }
});

test('monthly usage excludes drafts and pre-start cancellations, reserves future, and keeps consumed history', () => {
  const now = '2026-08-21T23:30:00Z';
  const promotions = [
    // Unpublished draft: excluded.
    { startsAt: '2026-08-21T23:00:00Z', endsAt: '2026-08-22T00:00:00Z', publishedAt: null },
    // Future published campaign: reserved.
    { startsAt: '2026-08-22T23:00:00Z', endsAt: '2026-08-23T00:00:00Z', publishedAt: '2026-08-20T00:00:00Z' },
    // Already started: consumed.
    { startsAt: '2026-08-21T23:00:00Z', endsAt: '2026-08-22T00:00:00Z', publishedAt: '2026-08-20T00:00:00Z' },
    // Manually ended after start: still consumed.
    { startsAt: '2026-08-20T20:00:00Z', endsAt: '2026-08-20T22:00:00Z', endedAt: '2026-08-20T21:00:00Z', publishedAt: '2026-08-19T00:00:00Z' },
    // Cancelled before start: released/excluded.
    { startsAt: '2026-08-24T20:00:00Z', endsAt: '2026-08-24T22:00:00Z', cancelledAt: '2026-08-23T20:00:00Z', publishedAt: '2026-08-19T00:00:00Z' },
    // Cancelled after start: still consumed.
    { startsAt: '2026-08-19T20:00:00Z', endsAt: '2026-08-19T22:00:00Z', cancelledAt: '2026-08-19T21:00:00Z', publishedAt: '2026-08-18T00:00:00Z' },
    // UTC September but still August in Pacific: reserves August allowance.
    { startsAt: '2026-09-01T06:30:00Z', endsAt: '2026-09-01T07:30:00Z', publishedAt: '2026-08-19T00:00:00Z' },
    // Pacific September: excluded from the requested August month.
    { startsAt: '2026-09-01T07:00:00Z', endsAt: '2026-09-01T08:00:00Z', publishedAt: '2026-08-19T00:00:00Z' },
  ];
  assert.deepEqual(getMonthlyPromotionUsage(promotions, { now, monthKey: '2026-08' }), {
    monthKey: '2026-08',
    consumed: 3,
    reserved: 2,
  });

  const entitlement = getPromotionEntitlement({
    plan: 'free',
    promotions,
    monthKey: '2026-08',
    now,
    env: {
      PROMOTION_FREE_MONTHLY_LIMIT: '6',
      PROMOTION_PRO_MONTHLY_LIMIT: 'unlimited',
      PROMOTION_FOUNDING_PARTNER_MONTHLY_LIMIT: 'unlimited',
    },
  });
  assert.equal(entitlement.consumed, 3);
  assert.equal(entitlement.reserved, 2);
  assert.equal(entitlement.remainingThisMonth, 1);
  assert.equal(entitlement.canLaunchPromotion, true);
});

test('finite entitlement subtracts consumed and reserved slots', () => {
  const entitlement = getPromotionEntitlement({
    plan: 'free',
    consumed: 1,
    reserved: 1,
    allowances: { free: 2 },
    env: EMPTY_ENV,
    now: '2026-08-21T20:00:00Z',
  });
  assert.equal(entitlement.remainingThisMonth, 0);
  assert.equal(entitlement.canLaunchPromotion, false);
});

test('admin-granted venue slots increase the effective monthly allowance', () => {
  const entitlement = getPromotionEntitlement({
    plan: 'free',
    consumed: 1,
    reserved: 1,
    additionalAllowance: 2,
    env: EMPTY_ENV,
    now: '2026-08-21T20:00:00Z',
  });
  assert.equal(entitlement.baseAllowance, 1);
  assert.equal(entitlement.additionalAllowance, 2);
  assert.equal(entitlement.allowance, 3);
  assert.equal(entitlement.remainingThisMonth, 1);
  assert.equal(entitlement.canLaunchPromotion, true);
});

// ---------------------------------------------------------------------------
// Stable notification event identities
// ---------------------------------------------------------------------------

test('happy-hour event key uses exact venue/Pacific date/start format', () => {
  const occurrence = getHappyHourOccurrenceForDate(fridayHappyHour, '2026-08-21');
  assert.ok(occurrence);
  assert.equal(getHappyHourEventKey(occurrence), 'hh:7:2026-08-21:16:00');
  assert.equal(getHappyHourEventKey(7, '2026-08-21T23:00:00Z'), 'hh:7:2026-08-21:16:00');
  assert.notEqual(
    getHappyHourEventKey({ venueId: 7, dateKey: '2026-08-22', startTime: '16:00' }),
    getHappyHourEventKey(occurrence)
  );
});

test('promotion event key is promotion-id-specific', () => {
  assert.equal(getPromotionEventKey('promo-a'), 'promotion:promo-a');
  assert.equal(getPromotionEventKey({ id: 'promo-b' }), 'promotion:promo-b');
  assert.notEqual(getPromotionEventKey('promo-a'), getPromotionEventKey('promo-b'));
});

// ---------------------------------------------------------------------------
// Promotion and alert-kind validation
// ---------------------------------------------------------------------------

test('alert kinds default omitted legacy input to HH only and preserve explicit choices', () => {
  assert.deepEqual([...ALERT_KINDS], ['happy_hour', 'promotion']);
  assert.deepEqual(cleanAlertKinds(undefined), ['happy_hour']);
  assert.deepEqual(cleanAlertKinds([]), []);
  assert.deepEqual(cleanAlertKinds(['promotion', 'happy_hour', 'promotion']), ['happy_hour', 'promotion']);
  assert.deepEqual(cleanAlertKinds(['unsupported']), []);
  assert.deepEqual(validateAlertKinds(undefined), { alertKinds: ['happy_hour'], errors: [] });
  assert.match(validateAlertKinds([]).errors.join(' '), /at least one alert kind/);
  assert.match(validateAlertKinds(['boost']).errors.join(' '), /only include happy_hour or promotion/);
  assert.match(
    validateAlertKinds(['happy_hour', 'boost']).errors.join(' '),
    /only include happy_hour or promotion/
  );
  assert.deepEqual(validateAlertKinds(['happy_hour', 'promotion']), {
    alertKinds: ['happy_hour', 'promotion'],
    errors: [],
  });
});

const validPromotionInput = {
  type: 'special_deal',
  title: '$5 Margaritas',
  description: 'Bar seating only.',
  dealCode: '',
  startsAt: '2026-08-21T23:00:00Z',
  endsAt: '2026-08-22T01:00:00Z',
};

test('valid published promotion accepts optional description/code and normalizes timestamps', () => {
  const result = validatePromotionInput(validPromotionInput, { mode: 'publish' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.promotion.dealCode, null);
  assert.equal(result.promotion.startsAt, '2026-08-21T23:00:00.000Z');
});

test('draft may omit timing and headline while still validating any supplied type', () => {
  assert.deepEqual(
    validatePromotionInput({ type: 'event', title: 'Trivia night', description: '', dealCode: null }).errors,
    []
  );
  assert.deepEqual(validatePromotionInput({ type: 'event', title: '' }).errors, []);
  assert.match(
    validatePromotionInput({ type: 'event', title: '' }, { mode: 'publish' }).errors.join(' '),
    /headline is required before publishing/
  );
});

test('promotion text limits are enforced without silent truncation', () => {
  assert.equal(PROMOTION_TITLE_MAX_LENGTH, 80);
  assert.equal(PROMOTION_DESCRIPTION_MAX_LENGTH, 200);
  assert.equal(PROMOTION_DEAL_CODE_MAX_LENGTH, 30);
  assert.deepEqual(
    validatePromotionInput({
      ...validPromotionInput,
      title: 't'.repeat(80),
      description: 'd'.repeat(200),
      dealCode: 'c'.repeat(30),
    }, { mode: 'publish' }).errors,
    []
  );
  const errors = validatePromotionInput({
    ...validPromotionInput,
    title: 't'.repeat(81),
    description: 'd'.repeat(201),
    dealCode: 'c'.repeat(31),
  }, { mode: 'publish' }).errors.join(' ');
  assert.match(errors, /80 characters/);
  assert.match(errors, /200 characters/);
  assert.match(errors, /30 characters/);
});

test('promotion type and absolute timestamps are validated', () => {
  assert.match(
    validatePromotionInput({ ...validPromotionInput, type: 'flash_deal' }, { mode: 'publish' }).errors.join(' '),
    /supported promotion type/
  );
  const offsetless = validatePromotionInput({
    ...validPromotionInput,
    startsAt: '2026-08-21T16:00',
    endsAt: '2026-08-21T18:00',
  }, { mode: 'publish' }).errors.join(' ');
  assert.match(offsetless, /valid absolute timestamp/);
});

test('promotion end is required, later than start, and at most 24 hours', () => {
  assert.equal(MAX_PROMOTION_DURATION_MS, 24 * 60 * 60 * 1000);
  assert.match(
    validatePromotionInput({ ...validPromotionInput, endsAt: '' }, { mode: 'publish' }).errors.join(' '),
    /end is required/
  );
  assert.match(
    validatePromotionInput({ ...validPromotionInput, endsAt: validPromotionInput.startsAt }, { mode: 'publish' }).errors.join(' '),
    /later than its start/
  );
  assert.deepEqual(
    validatePromotionInput({
      ...validPromotionInput,
      startsAt: '2026-08-21T00:00:00Z',
      endsAt: '2026-08-22T00:00:00Z',
    }, { mode: 'publish' }).errors,
    []
  );
  assert.match(
    validatePromotionInput({
      ...validPromotionInput,
      startsAt: '2026-08-21T00:00:00Z',
      endsAt: '2026-08-22T00:01:00Z',
    }, { mode: 'publish' }).errors.join(' '),
    /cannot exceed 24 hours/
  );
});

console.log(
  failures === 0
    ? '\nlive promotions: all checks passed'
    : `\nlive promotions: ${failures} failure(s)`
);
process.exitCode = failures ? 1 : 0;
