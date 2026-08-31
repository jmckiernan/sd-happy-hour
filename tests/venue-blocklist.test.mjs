import assert from 'node:assert/strict';
import fs from 'node:fs';

import { HAPPY_HOURS_PATH } from '../scripts/import-google-venues/lib/constants.mjs';
import { isBlockedChain } from '../scripts/import-google-venues/lib/chain-blocklist.mjs';
import {
  EXCLUDED_PRIMARY_TYPES,
  isExcludedCategory,
} from '../scripts/import-google-venues/lib/category-rules.mjs';

const tests = [];

function testCorporateChainsAreBlocked() {
  for (const name of [
    "McDonald's",
    'Starbucks Coffee Company',
    '7-Eleven',
    'Panera Bread',
    'Dutch Bros Coffee',
    'Chipotle Mexican Grill',
    'Blue Bottle Coffee',
    'Einstein Bros. Bagels',
    "Dave's Hot Chicken",
    '85°C Bakery Cafe - Mira Mesa',
    'Nekter Juice Bar',
    'Jollibee',
  ]) {
    assert.equal(isBlockedChain(name), true, `${name} should be blocked`);
  }
}

function testSitDownChainsWithRealHappyHoursSurvive() {
  // The line is not "chain". Every one of these runs a happy hour a visitor
  // came here to find, and deleting them would be the expensive mistake.
  for (const name of [
    "Chili's Grill & Bar",
    "Applebee's Grill + Bar",
    "BJ's Restaurant & Brewhouse",
    'Buffalo Wild Wings',
    'Olive Garden Italian Restaurant',
    'Texas Roadhouse',
    'Outback Steakhouse',
    'Yard House',
    'Red Robin Gourmet Burgers and Brews',
    'The Cheesecake Factory',
  ]) {
    assert.equal(isBlockedChain(name), false, `${name} must stay in the catalog`);
  }
}

function testLocalMultiLocationOperatorsSurvive() {
  // Several addresses under local ownership is the profile the business wants
  // most, not a reason to delete.
  for (const name of [
    'Bird Rock Coffee Roasters',
    'Lofty Coffee Co',
    'Communal Coffee',
    'Mostra Coffee',
    'The Taco Stand',
    'Sombrero Mexican Food',
    'Karl Strauss Brewing Company',
  ]) {
    assert.equal(isBlockedChain(name), false, `${name} must stay in the catalog`);
  }
}

function testABrandNameInsideALocalNameDoesNotTakeTheLocalNameOut() {
  assert.equal(isBlockedChain('Subway Tile Cafe'), false);
  assert.equal(isBlockedChain('Subway'), true);
  assert.equal(isBlockedChain('CAVA'), true);
  // A whole-name brand must not reach into an unrelated local business.
  assert.equal(isBlockedChain('Cava Wine Bar'), false);
  assert.equal(isBlockedChain('The Melt'), true);
  assert.equal(isBlockedChain('Meltdown Cocktail Lounge'), false);
  // The in-n-out spellings must never collapse to a bare "in".
  assert.equal(isBlockedChain('The Inn at Rancho Santa Fe'), false);
  assert.equal(isBlockedChain('In-N-Out Burger'), true);
}

function testNonVenueCategoriesAreExcluded() {
  assert.equal(isExcludedCategory('convenience_store', '7-Eleven'), true);
  assert.equal(isExcludedCategory('grocery_store', "Jimbo's - Escondido"), true);
  assert.equal(isExcludedCategory('book_store', 'Barnes & Noble'), true);
  assert.equal(isExcludedCategory('nail_salon', 'The Lullabar'), true);
  assert.equal(isExcludedCategory('motel', 'Sands Motel'), true);
}

function testCategoriesWithNoHappyHoursButRealVenuesAreKept() {
  // Zero hit rate is not the test. Each of these passes the owner's second or
  // third criterion on its own, and the audit doc argues each one by name.
  for (const [primaryType, name] of [
    ['coffee_shop', 'Bird Rock Coffee Roasters'],
    ['cafe', 'Communal Coffee'],
    ['tea_house', 'Bei Yuan Tea & Boba'],
    ['tea_store', 'OMOMO TEA SHOPPE'],
    ['donut_shop', 'Nomad Donuts'],
    ['breakfast_restaurant', 'Morning Glory'],
    ['thai_restaurant', 'Rakiraki'],
    ['liquor_store', 'Vino Carta Wine Shop and Bar'],
    ['hotel', 'The Pearl Hotel'],
    ['casino', 'Sycuan Casino Resort'],
    ['bowling_alley', 'Parkway Bowl'],
    ['comedy_club', 'American Comedy Co.'],
  ]) {
    assert.equal(isExcludedCategory(primaryType, name), false, `${primaryType} must stay`);
  }
}

function testGoogleMistypingALocalPlaceDoesNotDeleteIt() {
  // SD TapRoom is a real taproom with a real happy hour that Google types
  // pizza_delivery. It is the reason the name escape hatch exists.
  assert.equal(isExcludedCategory('pizza_delivery', 'SD TapRoom'), false);
  assert.equal(isExcludedCategory('store', 'Home Brew Mart'), false);
  assert.equal(isExcludedCategory('store', 'Excalibur Cigar & Scotch Lounge'), false);
  assert.equal(isExcludedCategory('grocery_store', 'El Pueblo Mexican Food & Bar'), false);
  // Fast food stays a brand judgement, not a category one: the type mostly
  // holds local independents Google mistyped.
  assert.equal(isExcludedCategory('fast_food_restaurant', "Angelo's Burgers"), false);
  assert.equal(isExcludedCategory('meal_takeaway', "It's Raw Poke Shop"), false);
}

function testTheRuleNeverExcludesATypeBreweriesCarry() {
  // Google tags a brewery `manufacturer`, and a San Diego "market" is often a
  // bar with a deli counter. Either one in this set would delete inventory.
  for (const type of ['manufacturer', 'market', 'restaurant', 'bar', 'brewery', 'winery', 'hotel', 'casino', 'event_venue']) {
    assert.equal(EXCLUDED_PRIMARY_TYPES.has(type), false, `${type} must not be excluded`);
  }
}

function testNoPublishedListingWithAHappyHourWouldBePurged() {
  const catalog = JSON.parse(fs.readFileSync(HAPPY_HOURS_PATH, 'utf8'));
  const casualties = catalog
    .filter((venue) => venue.listingStatus === 'published' || venue.hasHappyHourData)
    .filter((venue) => isBlockedChain(venue.name))
    .map((venue) => venue.name);
  assert.deepEqual(casualties, [], 'the blocklist must not reach a live happy hour');
}

tests.push(
  testCorporateChainsAreBlocked,
  testSitDownChainsWithRealHappyHoursSurvive,
  testLocalMultiLocationOperatorsSurvive,
  testABrandNameInsideALocalNameDoesNotTakeTheLocalNameOut,
  testNonVenueCategoriesAreExcluded,
  testCategoriesWithNoHappyHoursButRealVenuesAreKept,
  testGoogleMistypingALocalPlaceDoesNotDeleteIt,
  testTheRuleNeverExcludesATypeBreweriesCarry,
  testNoPublishedListingWithAHappyHourWouldBePurged,
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
console.log(`All ${tests.length} venue blocklist tests passed.`);
