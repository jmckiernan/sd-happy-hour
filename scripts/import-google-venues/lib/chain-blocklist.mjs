/**
 * Corporate fast-food brands that will never belong in this catalog.
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
 * Deliberately NOT here: sit-down chains like BJ's, Chili's, Applebee's,
 * Yard House or Outback. They are corporate too, but they run real happy hours
 * and are exactly what someone searching this site wants to find.
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
];

const FAST_FOOD = new RegExp(`(^|[^a-z0-9])(${BRANDS.join('|')})([^a-z0-9]|$)`, 'i');

/**
 * Brands whose name is an ordinary English word, so a substring match would
 * catch unrelated local businesses. These must be the whole listing name, give
 * or take a store number or the chain's own descriptor.
 */
const GENERIC_NAME_BRANDS =
  /^(subway|sonic)(\s*#?\s*\d+)?(\s+(sandwiches|restaurants?|drive-?in))?$/i;

/** Is this venue a corporate fast-food outlet we never want in the catalog? */
export function isCorporateFastFood(name) {
  const text = String(name || '').trim();
  return FAST_FOOD.test(text) || GENERIC_NAME_BRANDS.test(text);
}

export const FAST_FOOD_BRAND_COUNT = BRANDS.length;
