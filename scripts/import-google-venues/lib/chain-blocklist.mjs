/**
 * Corporate brands that will never belong in this catalog.
 *
 * Two independent reasons, and a brand needs both to earn a place on this list:
 *
 *   1. It does not run a happy hour, and never will — no bar, no discounted
 *      afternoon window. Anything we "extract" for one of these is a false
 *      positive. A Starbucks was published with a 09:00 "happy hour" before
 *      this list existed.
 *   2. It will never claim a listing. Franchise marketing runs through
 *      corporate software, not a local owner filling in a form, so carrying it
 *      as a claimable stub serves nobody.
 *
 * The line is not "chain". Deliberately NOT here: sit-down chains like BJ's,
 * Chili's, Applebee's, Yard House, Outback, Buffalo Wild Wings, Olive Garden
 * or Texas Roadhouse. They are corporate too, but they have a bar, they run
 * real happy hours, and they are exactly what someone searching this site
 * wants to find. Nor is the line "multi-location": Bird Rock Coffee Roasters,
 * Lofty, Communal, Mostra and The Taco Stand all hold several San Diego
 * addresses under local ownership and all belong here.
 *
 * What a brand on this list has in common is that its afternoon pricing is set
 * in a head office and its marketing reaches customers through its own app, so
 * there is no local operator with anything to gain from claiming a page.
 *
 * Match on the brand as a whole word so a local business that merely contains
 * the substring survives — "Subway" must not take out "Subway Tile Cafe", and
 * the `in-n-out` spelling variants must never collapse to a bare "in".
 */
const BRANDS = [
  'in-?n-?out(?: burger)?',
  'in n out(?: burger)?',
  "mcdonald'?s",
  "wendy'?s",
  'jack in the box',
  'burger king',
  'chick-?fil-?a',
  'starbucks',
  'kfc',
  'kentucky fried chicken',
  'taco bell',
  'del taco',
  "domino'?s(?: pizza)?",
  'pizza hut',
  "popeyes?'?s?(?: louisiana kitchen)?",
  "papa john'?s",
  "dunkin'?(?: donuts)?",
  'krispy kreme',
  // Same two tests, same answer.
  "carl'?s jr",
  "arby'?s",
  'sonic drive-?in',
  'panda express',
  "raising cane'?s",
  'little caesar\'?s?',
  "jimmy john'?s",
  'five guys',
  'whataburger',
  "hardee'?s",
  'quiznos',
  "jersey mike'?s",
  'firehouse subs',
  "wingstop",
  'el pollo loco',
  "church'?s (?:chicken|texas chicken)",
  'baskin-?robbins',
  'cinnabon',
  "auntie anne'?s",
  "tim hortons",
  "peet'?s coffee",
  'the coffee bean(?: & tea leaf)?',
  "caribou coffee",
  // Corporate coffee, bakery and quick-serve beyond the drive-thru window.
  // Same two tests as everything above: 21 Panera Breads and 8 Dutch Bros in
  // the enriched cache, not one happy hour between them, and the loyalty app
  // is the only channel any of them market through.
  'blue bottle coffee',
  'philz coffee',
  'black rock coffee(?: bar)?',
  'dutch bros(?: coffee)?',
  'panera(?: bread)?',
  'einstein bros\\.?(?: bagels)?',
  "bruegger'?s bagels",
  'paris baguette',
  'corner bakery(?: cafe)?',
  '85\\s*°?\\s*c bakery cafe',
  'yum yum donuts',
  "winchell'?s donut(?: house)?",
  "foster'?s freeze",
  'nekter juice bar',
  'jamba(?: juice)?',
  'sweetgreen',
  'chipotle(?: mexican grill)?',
  'the habit burger(?: grill)?',
  'habit burger(?: grill)?',
  "dave'?s hot chicken",
  'jollibee',
  'shake smart',
  // Convenience and gas-station marts. The category rules in
  // category-rules.mjs catch these by type, but discovery sometimes hands us a
  // candidate with no primaryType at all, and the name is never ambiguous.
  '7-?\\s?eleven',
  'circle k',
  'extramile',
  // Not a venue in any sense: a refrigerated vending kiosk in an office lobby.
  "farmer'?s fridge",
];

const FAST_FOOD = new RegExp(`(^|[^a-z0-9])(${BRANDS.join('|')})([^a-z0-9]|$)`, 'i');

/**
 * Brands whose name is an ordinary English word, so a substring match would
 * catch unrelated local businesses. These must be the whole listing name, give
 * or take a store number or the chain's own descriptor.
 */
const GENERIC_NAME_BRANDS =
  /^(subway|sonic|cava|ampm|am\/pm|the melt)(\s*#?\s*\d+)?(\s+(sandwiches|restaurants?|drive-?in|grill|mediterranean))?$/i;

/** Is this venue a corporate chain we never want in the catalog? */
export function isBlockedChain(name) {
  const text = String(name || '').trim();
  return FAST_FOOD.test(text) || GENERIC_NAME_BRANDS.test(text);
}

export const BLOCKED_BRAND_COUNT = BRANDS.length;
