import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyDealCode,
  deriveConsumerPromotionState,
  filterLiveDealsForDiscovery,
  isPublicLivePromotion,
  isPublicPromotionLiveAt,
  redactPromotionDealCodes,
} from '../src/lib/consumerPromotionState.ts';
import {
  DEFAULT_LIVE_PROMOTION_FAILURE_INTERVAL_MS,
  DEFAULT_LIVE_PROMOTION_POLL_INTERVAL_MS,
  createLivePromotionFeed,
} from '../src/lib/livePromotionFeed.ts';
import {
  createServerAnchoredClock,
  formatCountdown,
  formatSanDiegoDateTime,
  formatSanDiegoDateTimeInput,
  formatSanDiegoTime,
  resolveSanDiegoDateTimeLocal,
} from '../src/lib/promotionClientTime.ts';

const FEED_NOW = '2026-08-22T01:00:00.000Z';

function promotion(overrides = {}) {
  const { venue: venueOverrides = {}, ...promotionOverrides } = overrides;
  const baseVenue = {
    id: 1,
    name: 'North Park Social',
    slug: 'north-park-social',
    neighborhood: 'North Park',
    image: '/images/north-park-social.jpg',
  };
  const result = {
    id: 'promo-1',
    venueId: 1,
    venue: baseVenue,
    type: 'special_deal',
    title: 'Sunset tacos',
    description: 'Two tacos and a house drink.',
    startsAt: '2026-08-22T00:30:00.000Z',
    endsAt: '2026-08-22T03:00:00.000Z',
    effectiveEndsAt: '2026-08-22T03:00:00.000Z',
    state: 'live',
    hasDealCode: false,
    ...promotionOverrides,
  };
  result.venue = { ...baseVenue, ...venueOverrides, id: result.venueId };
  return result;
}

function payload(promotions, serverNow = FEED_NOW) {
  return { serverNow, promotions };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeFeedRuntime {
  nowMs = 0;
  visible = true;
  online = true;
  calls = [];
  responses = [];
  timers = new Map();
  nextTimer = 1;
  visibilityListeners = new Set();
  pageShowListeners = new Set();
  onlineListeners = new Set();

  fetch = (input, init) => {
    this.calls.push({ input: String(input), init });
    const response = this.responses.shift();
    if (!response) return Promise.reject(new Error('No fake response was queued.'));
    return typeof response === 'function' ? response(input, init) : Promise.resolve(response);
  };

  monotonicNow = () => this.nowMs;

  setTimer = (callback, delayMs) => {
    const handle = this.nextTimer++;
    this.timers.set(handle, { callback, due: this.nowMs + delayMs });
    return handle;
  };

  clearTimer = (handle) => {
    this.timers.delete(handle);
  };

  isVisible = () => this.visible;
  isOnline = () => this.online;

  onVisibilityChange = (callback) => this.addListener(this.visibilityListeners, callback);
  onPageShow = (callback) => this.addListener(this.pageShowListeners, callback);
  onOnline = (callback) => this.addListener(this.onlineListeners, callback);

  addListener(collection, callback) {
    collection.add(callback);
    return () => collection.delete(callback);
  }

  queue(body, status = 200) {
    this.responses.push(jsonResponse(body, status));
  }

  queueError(error) {
    this.responses.push(() => Promise.reject(error));
  }

  setVisible(visible) {
    this.visible = visible;
    for (const listener of this.visibilityListeners) listener();
  }

  showPage() {
    for (const listener of this.pageShowListeners) listener();
  }

  setOnline(online) {
    this.online = online;
    if (online) for (const listener of this.onlineListeners) listener();
  }

  async advance(milliseconds) {
    const target = this.nowMs + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      const [handle, timer] = next;
      this.timers.delete(handle);
      this.nowMs = timer.due;
      timer.callback();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    }
    this.nowMs = target;
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }
}

test('server clock uses half RTT, advances monotonically, and cannot regress', () => {
  let monotonic = 200;
  const clock = createServerAnchoredClock({
    serverNow: '2026-08-22T01:00:00.000Z',
    requestStartedAt: 0,
    responseReceivedAt: 200,
    monotonicNow: () => monotonic,
  });

  assert.equal(clock.now().toISOString(), '2026-08-22T01:00:00.100Z');
  monotonic = 1_200;
  assert.equal(clock.now().toISOString(), '2026-08-22T01:00:01.100Z');
  monotonic = 900;
  assert.equal(clock.now().toISOString(), '2026-08-22T01:00:01.100Z');
  monotonic = 1_300;
  assert.equal(clock.now().toISOString(), '2026-08-22T01:00:01.200Z');
  assert.throws(
    () => createServerAnchoredClock({ serverNow: '2026-08-22T01:00' }),
    /absolute instant/
  );
});

test('San Diego local input resolution delegates DST gaps and folds to Phase 1', () => {
  const winter = resolveSanDiegoDateTimeLocal('2026-01-15T17:00');
  const summer = resolveSanDiegoDateTimeLocal('2026-08-21T17:00');
  const gap = resolveSanDiegoDateTimeLocal('2026-03-08T02:30');
  const fold = resolveSanDiegoDateTimeLocal('2026-11-01T01:30');

  assert.equal(winter.status, 'resolved');
  assert.equal(winter.instant.toISOString(), '2026-01-16T01:00:00.000Z');
  assert.equal(summer.status, 'resolved');
  assert.equal(summer.instant.toISOString(), '2026-08-22T00:00:00.000Z');
  assert.deepEqual(gap, { status: 'nonexistent' });
  assert.equal(fold.status, 'ambiguous');
  assert.equal(fold.earlier.toISOString(), '2026-11-01T08:30:00.000Z');
  assert.equal(fold.later.toISOString(), '2026-11-01T09:30:00.000Z');
  assert.deepEqual(resolveSanDiegoDateTimeLocal('2026-02-30T12:00'), { status: 'invalid' });
  assert.deepEqual(resolveSanDiegoDateTimeLocal('not-a-date'), { status: 'invalid' });
});

test('San Diego formatters are timezone-fixed and countdown boundaries are explicit', () => {
  assert.equal(
    formatSanDiegoDateTimeInput('2026-08-22T01:30:45.000Z'),
    '2026-08-21T18:30'
  );
  assert.equal(formatSanDiegoTime('2026-08-21T07:00:00.000Z'), '12:00 AM');
  assert.equal(formatSanDiegoTime('2026-08-21T19:00:00.000Z'), '12:00 PM');
  assert.match(formatSanDiegoDateTime('2026-11-01T08:30:00.000Z'), /PDT$/);
  assert.match(formatSanDiegoDateTime('2026-11-01T09:30:00.000Z'), /PST$/);
  assert.equal(formatCountdown('2026-08-22T02:20:00Z', FEED_NOW), '1h 20m');
  assert.equal(formatCountdown('2026-08-22T02:00:00Z', FEED_NOW), '1h');
  assert.equal(formatCountdown('2026-08-22T01:00:01Z', FEED_NOW), '1m');
  assert.equal(formatCountdown(FEED_NOW, FEED_NOW), null);
  assert.equal(formatCountdown('2026-08-22T00:59:59Z', FEED_NOW), null);
  assert.throws(() => formatSanDiegoTime('2026-08-21T12:00'), /absolute instant/);
});

test('consumer state distinguishes HH only, Live Deal only, both, and neither', () => {
  const schedule = { id: 1, days: ['Friday'], startTime: '17:00', endTime: '19:00' };
  const activePromotion = promotion();
  const base = { venueId: 1, now: FEED_NOW };

  assert.equal(
    deriveConsumerPromotionState({ ...base, schedule: null, promotions: [] }).state,
    'neither'
  );
  assert.equal(
    deriveConsumerPromotionState({ ...base, schedule, promotions: [] }).state,
    'happy-hour-only'
  );
  assert.equal(
    deriveConsumerPromotionState({ ...base, schedule: null, promotions: [activePromotion] }).state,
    'live-deal-only'
  );
  const both = deriveConsumerPromotionState({ ...base, schedule, promotions: [activePromotion] });
  assert.equal(both.state, 'both');
  assert.equal(both.liveDeals.length, 1);
  assert.ok(both.happyHourOccurrence);
});

test('consumer activity uses half-open boundaries and requested venue only', () => {
  const schedule = { id: 1, days: ['Friday'], startTime: '17:00', endTime: '19:00' };
  assert.ok(deriveConsumerPromotionState({
    venueId: 1,
    schedule,
    promotions: [],
    now: '2026-08-22T00:00:00Z',
  }).happyHourOccurrence);
  assert.equal(deriveConsumerPromotionState({
    venueId: 1,
    schedule,
    promotions: [],
    now: '2026-08-22T02:00:00Z',
  }).happyHourOccurrence, null);

  const endingEarly = promotion({
    endsAt: '2026-08-22T03:00:00Z',
    effectiveEndsAt: '2026-08-22T01:15:00Z',
  });
  assert.equal(isPublicPromotionLiveAt(endingEarly, endingEarly.startsAt), true);
  assert.equal(isPublicPromotionLiveAt(endingEarly, endingEarly.effectiveEndsAt), false);
  assert.equal(isPublicPromotionLiveAt({ ...endingEarly, startsAt: '2026-08-21T17:00' }, FEED_NOW), false);

  const otherVenue = promotion({ id: 'promo-2', venueId: 2, venue: { id: 2, name: 'Elsewhere' } });
  const state = deriveConsumerPromotionState({
    venueId: 1,
    promotions: [otherVenue, promotion()],
    now: FEED_NOW,
  });
  assert.deepEqual(state.liveDeals.map((item) => item.id), ['promo-1']);
  assert.equal(deriveConsumerPromotionState({
    venueId: 2,
    schedule,
    promotions: [],
    now: FEED_NOW,
  }).state, 'neither');
  assert.throws(() => deriveConsumerPromotionState({
    venueId: 1,
    promotions: [],
    now: '2026-08-21T18:00',
  }), /absolute instant/);
});

test('Live Deal discovery respects neighborhood and relevant search intent', () => {
  const northPark = promotion();
  const gaslamp = promotion({
    id: 'promo-2',
    venueId: 2,
    title: 'Late-night jazz',
    description: 'Live quartet.',
    type: 'event',
    venue: {
      id: 2,
      name: 'Gaslamp Lounge',
      slug: 'gaslamp-lounge',
      neighborhood: 'Gaslamp Quarter',
      image: '/images/gaslamp.jpg',
    },
  });

  assert.deepEqual(
    filterLiveDealsForDiscovery([northPark, gaslamp], { neighborhood: 'north park' })
      .map((item) => item.id),
    ['promo-1']
  );
  assert.deepEqual(
    filterLiveDealsForDiscovery([northPark, gaslamp], { query: 'sunset tacos' })
      .map((item) => item.id),
    ['promo-1']
  );
  assert.deepEqual(
    filterLiveDealsForDiscovery([northPark, gaslamp], { query: 'Gaslamp event' })
      .map((item) => item.id),
    ['promo-2']
  );
  assert.deepEqual(
    filterLiveDealsForDiscovery([northPark, gaslamp], { query: 'rooftop' }, {
      venueSearchText: (venueId) => venueId === 1 ? ['University Ave', 'rooftop', 'dog friendly'] : null,
    }).map((item) => item.id),
    ['promo-1']
  );
});

test('Live Deal discovery is radius-ready and excludes recurring-only filter fields', () => {
  const northPark = promotion({ dealCode: 'PRIVATECODE' });
  const gaslamp = promotion({
    id: 'promo-2',
    venueId: 2,
    venue: {
      id: 2,
      name: 'Gaslamp Lounge',
      slug: 'gaslamp-lounge',
      neighborhood: 'Gaslamp Quarter',
      image: '/images/gaslamp.jpg',
    },
  });
  const coordinates = new Map([
    [1, { latitude: 32.747, longitude: -117.13 }],
    [2, { latitude: 32.7115, longitude: -117.16 }],
  ]);
  const radius = {
    center: { latitude: 32.747, longitude: -117.13 },
    miles: 1,
  };

  assert.deepEqual(
    filterLiveDealsForDiscovery([northPark, gaslamp], { radius }, {
      venueCoordinates: (venueId) => coordinates.get(venueId),
    }).map((item) => item.id),
    ['promo-1']
  );
  assert.deepEqual(
    filterLiveDealsForDiscovery([northPark, gaslamp], {
      neighborhood: 'North Park',
      query: 'tacos',
      radius,
    }, {
      venueCoordinates: (venueId) => coordinates.get(venueId),
    }).map((item) => item.id),
    ['promo-1']
  );
  assert.deepEqual(filterLiveDealsForDiscovery([northPark], { query: 'PRIVATECODE' }), []);
  assert.deepEqual(
    filterLiveDealsForDiscovery([northPark, gaslamp], {
      day: 'Monday',
      happyHourNow: true,
      dealType: 'beer',
    }).map((item) => item.id),
    ['promo-1', 'promo-2']
  );
  assert.throws(
    () => filterLiveDealsForDiscovery([northPark], {
      radius: { center: { latitude: 91, longitude: 0 }, miles: 1 },
    }),
    /valid center/
  );
  assert.deepEqual(filterLiveDealsForDiscovery([northPark], { radius }, {
    venueCoordinates: () => coordinates.get(1),
    distanceMiles: () => -1,
  }), []);
});

test('deal-code classification and redaction follow the authenticated API contract', () => {
  const noCode = promotion({ hasDealCode: false, dealCode: null });
  const gated = promotion({ hasDealCode: true });
  const revealed = promotion({ hasDealCode: true, dealCode: ' SAVE20 ' });
  assert.deepEqual(classifyDealCode(noCode), { kind: 'none' });
  assert.deepEqual(classifyDealCode(gated), { kind: 'gated' });
  assert.deepEqual(classifyDealCode(revealed), { kind: 'revealed', code: 'SAVE20' });
  const redacted = redactPromotionDealCodes([noCode, revealed]);
  assert.equal(Object.hasOwn(redacted[0], 'dealCode'), false);
  assert.equal(Object.hasOwn(redacted[1], 'dealCode'), false);
  assert.equal(revealed.dealCode, ' SAVE20 ');
  assert.equal(isPublicLivePromotion(revealed), true);
  assert.equal(isPublicLivePromotion(promotion({ dealCode: 'CONTRADICTORY' })), false);
  assert.equal(isPublicLivePromotion({ ...revealed, startsAt: '2026-08-21T17:00' }), false);
});

test('feed starts immediately with correct endpoint and request privacy options', async () => {
  const runtime = new FakeFeedRuntime();
  runtime.queue(payload([promotion()]));
  const feed = createLivePromotionFeed({ venueId: 1, runtime });
  feed.start();
  await feed.refresh();

  assert.equal(runtime.calls.length, 1);
  assert.equal(runtime.calls[0].input, '/api/promotions/live?venueId=1');
  assert.equal(runtime.calls[0].init.credentials, 'same-origin');
  assert.equal(runtime.calls[0].init.cache, 'no-store');
  assert.equal(runtime.calls[0].init.headers.accept, 'application/json');
  assert.equal(feed.getSnapshot().data.promotions.length, 1);
  assert.equal(feed.getSnapshot().error, null);
  assert.throws(() => createLivePromotionFeed({ venueId: 0, runtime }), /positive safe integer/);
  feed.stop();
});

test('feed polls at a bounded cadence and pauses while hidden', async () => {
  const runtime = new FakeFeedRuntime();
  runtime.queue(payload([promotion()]));
  runtime.queue(payload([promotion()], '2026-08-22T01:01:00.000Z'));
  const feed = createLivePromotionFeed({ runtime });
  feed.start();
  await feed.refresh();

  await runtime.advance(DEFAULT_LIVE_PROMOTION_POLL_INTERVAL_MS - 1);
  assert.equal(runtime.calls.length, 1);
  await runtime.advance(1);
  assert.equal(runtime.calls.length, 2);

  runtime.setVisible(false);
  await runtime.advance(DEFAULT_LIVE_PROMOTION_POLL_INTERVAL_MS * 2);
  assert.equal(runtime.calls.length, 2);
  runtime.queue(payload([], '2026-08-22T01:03:00.000Z'));
  runtime.setVisible(true);
  await feed.refresh();
  assert.equal(runtime.calls.length, 3);
  feed.stop();
});

test('hidden/offline startup waits, then visibility, pageshow, and online reconcile', async () => {
  const runtime = new FakeFeedRuntime();
  runtime.visible = false;
  runtime.online = false;
  const feed = createLivePromotionFeed({ runtime });
  feed.start();
  assert.equal(runtime.calls.length, 0);

  runtime.visible = true;
  runtime.queue(payload([]));
  runtime.setOnline(true);
  await feed.refresh();
  assert.equal(runtime.calls.length, 1);

  runtime.queue(payload([], '2026-08-22T01:00:01.000Z'));
  runtime.showPage();
  await feed.refresh();
  assert.equal(runtime.calls.length, 2);
  feed.stop();
});

test('feed failures retain safe data and use the bounded failure interval', async () => {
  const runtime = new FakeFeedRuntime();
  runtime.queue(payload([promotion()]));
  const feed = createLivePromotionFeed({ runtime });
  feed.start();
  await feed.refresh();

  runtime.queueError(new Error('offline'));
  await feed.refresh();
  assert.equal(feed.getSnapshot().data.promotions.length, 1);
  assert.match(feed.getSnapshot().error.message, /offline/);
  await runtime.advance(DEFAULT_LIVE_PROMOTION_FAILURE_INTERVAL_MS - 1);
  assert.equal(runtime.calls.length, 2);

  runtime.queue(payload([], '2026-08-22T01:05:00.000Z'));
  await runtime.advance(1);
  assert.equal(runtime.calls.length, 3);
  assert.equal(feed.getSnapshot().error, null);
  assert.deepEqual(feed.getSnapshot().data.promotions, []);
  feed.stop();
});

test('feed prunes at the exact effective end and replaces response collections', async () => {
  const runtime = new FakeFeedRuntime();
  const ending = promotion({
    hasDealCode: true,
    dealCode: 'FIRST',
    endsAt: '2026-08-22T01:00:30.000Z',
    effectiveEndsAt: '2026-08-22T01:00:30.000Z',
  });
  runtime.queue(payload([ending]));
  runtime.queue(payload([], '2026-08-22T01:00:30.000Z'));
  const feed = createLivePromotionFeed({ runtime });
  feed.start();
  await feed.refresh();
  assert.equal(feed.getSnapshot().data.promotions[0].dealCode, 'FIRST');

  await runtime.advance(30_000);
  assert.deepEqual(feed.getSnapshot().data.promotions, []);
  assert.equal(runtime.calls.length, 2);
  feed.stop();
});

test('invalid feed responses never replace the last safe collection', async () => {
  const runtime = new FakeFeedRuntime();
  runtime.queue(payload([promotion()]));
  const feed = createLivePromotionFeed({ runtime });
  feed.start();
  await feed.refresh();

  runtime.queue(payload([promotion()], 'not-an-instant'));
  await feed.refresh();
  assert.deepEqual(feed.getSnapshot().data.promotions.map((item) => item.id), ['promo-1']);
  assert.ok(feed.getSnapshot().error);

  runtime.queue({ errors: ['nope'] }, 500);
  await feed.refresh();
  assert.deepEqual(feed.getSnapshot().data.promotions.map((item) => item.id), ['promo-1']);
  assert.equal(feed.getSnapshot().error.status, 500);
  feed.stop();
});

test('authentication changes redact immediately and stale requests cannot restore codes', async () => {
  const runtime = new FakeFeedRuntime();
  runtime.queue(payload([promotion({ hasDealCode: true, dealCode: 'SIGNEDIN' })]));
  const feed = createLivePromotionFeed({ runtime });
  feed.start();
  await feed.refresh();

  const oldRequest = deferred();
  runtime.responses.push(() => oldRequest.promise);
  const pendingRefresh = feed.refresh();
  const oldSignal = runtime.calls.at(-1).init.signal;
  runtime.queue(payload([promotion({ hasDealCode: true })], '2026-08-22T01:00:01.000Z'));
  const authenticationRefresh = feed.authenticationChanged();

  assert.equal(oldSignal.aborted, true);
  assert.equal(Object.hasOwn(feed.getSnapshot().data.promotions[0], 'dealCode'), false);
  oldRequest.resolve(jsonResponse(payload([
    promotion({ hasDealCode: true, dealCode: 'STALE' }),
  ], '2026-08-22T01:00:00.500Z')));
  await pendingRefresh;
  await authenticationRefresh;
  assert.equal(Object.hasOwn(feed.getSnapshot().data.promotions[0], 'dealCode'), false);
  assert.equal(runtime.calls.length, 3);
  feed.stop();
});

test('venue-scoped feeds fail closed and stop aborts late work and removes listeners', async () => {
  const runtime = new FakeFeedRuntime();
  runtime.queue(payload([promotion({ venueId: 2, venue: { id: 2 } })]));
  const feed = createLivePromotionFeed({ venueId: 1, runtime });
  feed.start();
  await feed.refresh();
  assert.equal(feed.getSnapshot().data, null);
  assert.match(feed.getSnapshot().error.message, /another venue/);

  const late = deferred();
  runtime.responses.push(() => late.promise);
  const pending = feed.refresh();
  const signal = runtime.calls.at(-1).init.signal;
  feed.stop();
  assert.equal(signal.aborted, true);
  assert.equal(runtime.timers.size, 0);
  assert.equal(runtime.visibilityListeners.size, 0);
  assert.equal(runtime.pageShowListeners.size, 0);
  assert.equal(runtime.onlineListeners.size, 0);
  late.resolve(jsonResponse(payload([promotion()])));
  await pending;
  assert.equal(feed.getSnapshot().data, null);
});

test('feed restart reconciles after an aborted request finishes settling', async () => {
  const runtime = new FakeFeedRuntime();
  const late = deferred();
  runtime.responses.push(() => late.promise);
  const feed = createLivePromotionFeed({ runtime });
  feed.start();
  const firstRequest = feed.refresh();
  feed.stop();

  runtime.queue(payload([promotion()]));
  feed.start();
  assert.equal(runtime.calls.length, 1);
  late.resolve(jsonResponse(payload([])));
  await firstRequest;
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(runtime.calls.length, 2);
  assert.deepEqual(feed.getSnapshot().data.promotions.map((item) => item.id), ['promo-1']);
  feed.stop();
});
