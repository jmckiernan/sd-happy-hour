import assert from 'node:assert/strict';
import fs from 'node:fs';

import { VENUE_ID_BAND, HAPPY_HOURS_PATH } from '../scripts/import-google-venues/lib/constants.mjs';
import { createVenueIdAllocator, highestIdInBand } from '../scripts/import-google-venues/lib/venue-ids.mjs';

const tests = [];

function testAllocationContinuesAfterTheHighestIdInUse() {
  const venues = [{ id: 12 }, { id: 3504 }, { id: 7 }];
  const ids = createVenueIdAllocator(venues);
  assert.equal(ids.take(), 3505);
  assert.equal(ids.take(), 3506);
}

function testAnEmptyCatalogStartsAtTheBottomOfItsBand() {
  const band = { start: 100_000, end: 199_999 };
  const ids = createVenueIdAllocator([], band);
  assert.equal(ids.take(), 100_000);
  assert.equal(ids.take(), 100_001);
}

function testAnotherCitysIdsNeverMoveThisCitysCursor() {
  // The failure this band exists to prevent: two catalogs in one database. A
  // row carrying a second city's id must not drag San Diego's allocation into
  // that city's range.
  const band = { start: 1, end: 99_999 };
  const ids = createVenueIdAllocator([{ id: 40 }, { id: 150_000 }], band);
  assert.equal(ids.take(), 41);
  assert.equal(highestIdInBand([{ id: 150_000 }], band), null);
}

function testPeekingDoesNotBurnAnId() {
  const ids = createVenueIdAllocator([{ id: 5 }]);
  assert.equal(ids.peek(), 6);
  assert.equal(ids.peek(), 6);
  assert.equal(ids.take(), 6);
  assert.equal(ids.take(), 7);
}

function testAllocationPastTheEndOfTheBandFailsLoudly() {
  const band = { start: 1, end: 3 };
  const ids = createVenueIdAllocator([{ id: 2 }], band);
  assert.equal(ids.take(), 3);
  assert.throws(() => ids.take(), /reserved band 1–3/);
  // Still refuses on a second attempt rather than drifting into the next city.
  assert.throws(() => ids.peek(), /reserved band 1–3/);
}

function testEveryCatalogedVenueSitsInsideSanDiegosBand() {
  const venues = JSON.parse(fs.readFileSync(HAPPY_HOURS_PATH, 'utf8'));
  const outside = venues.filter((venue) => venue.id < VENUE_ID_BAND.start || venue.id > VENUE_ID_BAND.end);
  assert.deepEqual(outside.map((venue) => venue.id), [], 'catalog ids must fit the band without renumbering');
}

tests.push(
  testAllocationContinuesAfterTheHighestIdInUse,
  testAnEmptyCatalogStartsAtTheBottomOfItsBand,
  testAnotherCitysIdsNeverMoveThisCitysCursor,
  testPeekingDoesNotBurnAnId,
  testAllocationPastTheEndOfTheBandFailsLoudly,
  testEveryCatalogedVenueSitsInsideSanDiegosBand,
);

let failed = 0;
for (const test of tests) {
  try {
    await test();
    console.log(`✓ ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${test.name}: ${error.message}`);
  }
}

if (failed) process.exit(1);
console.log(`All ${tests.length} venue id band tests passed.`);
