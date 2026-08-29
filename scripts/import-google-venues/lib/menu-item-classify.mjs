/**
 * Turn a transcribed menu item into comparable fields for the database.
 *
 * Menus price things in prose ("½ off", "6/9", "$2 off draft"), which is fine
 * on a board and useless in a WHERE clause. This module is the one place that
 * decides what a price string means, so the audit, the sync and any later
 * analysis all agree. See migrations/0018_happy_hour_menus.sql for the
 * columns these map onto.
 */

const HALF = /(?:^|\b)(?:1\/2|½|half)\s*(?:-|\s)?\s*(?:off|price)\b/i;

function toNumber(raw) {
  const value = Number(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(value) && value >= 0 && value < 10_000 ? value : null;
}

/**
 * @returns {{ priceKind: string, priceAmount: number|null, priceAmountMax: number|null,
 *   discountAmount: number|null, discountPercent: number|null }}
 */
export function classifyPrice(priceText) {
  const text = String(priceText || '').replace(/\s+/g, ' ').trim();
  const none = {
    priceKind: 'other',
    priceAmount: null,
    priceAmountMax: null,
    discountAmount: null,
    discountPercent: null,
  };
  if (!text) return none;

  if (HALF.test(text)) return { ...none, priceKind: 'half_off', discountPercent: 50 };

  const percentOff = /(\d{1,2}(?:\.\d+)?)\s*%\s*off/i.exec(text);
  if (percentOff) {
    return { ...none, priceKind: 'percent_off', discountPercent: toNumber(percentOff[1]) };
  }

  const amountOff = /\$?\s*(\d+(?:\.\d{1,2})?)\s*off\b/i.exec(text);
  if (amountOff) {
    return { ...none, priceKind: 'amount_off', discountAmount: toNumber(amountOff[1]) };
  }

  // "6/9" and "$6–$9" are one item at two sizes, not two items.
  const range = /\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:\/|–|—|-|\bto\b)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i.exec(text);
  if (range) {
    const low = toNumber(range[1]);
    const high = toNumber(range[2]);
    if (low !== null && high !== null && high > low) {
      return { ...none, priceKind: 'range', priceAmount: low, priceAmountMax: high };
    }
  }

  const fixed = /\$?\s*(\d+(?:\.\d{1,2})?)/.exec(text);
  if (fixed) {
    const amount = toNumber(fixed[1]);
    if (amount !== null && amount > 0) {
      return { ...none, priceKind: 'fixed', priceAmount: amount };
    }
  }

  return none;
}

/**
 * Ordered most specific first: "frozen margarita" is a cocktail, not a
 * wine-adjacent "rosé"; "n/a beer" is non-alcoholic, not beer.
 */
const CATEGORY_RULES = [
  ['na_beverage', /\bn\/?a\b|non[-\s]?alcoholic|zero\s*proof|mocktail|virgin\b|kombucha|\bsoda\b|iced tea|lemonade|coffee|espresso/i],
  ['oysters', /oyster/i],
  // Classic and tiki names are as standard as "IPA" is for beer, and are the
  // only signal when a bar prints a drinks list with no styles or headings.
  ['cocktail', /cocktail|margarita|\brita\b|martini|mojito|mule|spritz|negroni|paloma|old fashioned|daiquiri|sangria|punch|highball|bomber|shot\b|frozen|slushie|libation|\btiki\b|cooler\b|mai tai|zombie|painkiller|hurricane|colada|gimlet|cosmo|manhattan|sazerac|aperol|bellini|mimosa|collins|bloody mary|caipirinha|\bpisco\b|\bspritzer\b|\bjulep\b/i],
  // Macro brands and style words carry no other signal on a board: a bare
  // "Coors Light" under a "Drinks" heading is only classifiable by name.
  ['beer', /\bbeer|\bdraft|draught|\blager|\bipa\b|pilsner|stout|porter|\bale\b|cider|seltzer|pint|\bcan\b|\bbottle.*(?:beer|lager)|half yard|schooner|michelada|\bdomestics?\b|bottled beer|blonde|hefe|kolsch|hazy|\bamber\b|coors|\bbud(?:weiser|\s*light)?\b|miller|michelob|stella|pacifico|modelo|corona|tecate|dos equis|heineken|guinness|sapporo|\bkirin\b|asahi/i],
  ['wine', /\bwine|prosecco|champagne|cava|rosé|rose\b|cabernet|chardonnay|pinot|sauvignon|merlot|malbec|sav blanc|bubbles|\bsake\b|\bglass\b|by the glass/i],
  ['spirit', /whiskey|whisky|bourbon|tequila|mezcal|vodka|\bgin\b|\brum\b|scotch|cognac|\bsoju\b|\bshoju\b|brandy|\bwell\b|wells\b|call drinks?|call liquor|top shelf|liquor|spirits?\b/i],
  // The trailing heading words ("Mains", "Greens") rarely appear in an item
  // name but are how most kitchens label a section, which is what rescues
  // house-invented names like "Phrings" from landing in `other`.
  ['food', /taco|wing|burger|slider|fries|frites|onion ring|burrito|birria|carnitas|asada|torta|sausage|nacho|pizza|dip|hummus|salad|roll|sushi|sashimi|crudo|ceviche|empanada|quesadilla|guacamole|chips|bites|skewer|meatball|calamari|shrimp|edamame|dumpling|flatbread|sandwich|bao|rib|eggplant|brussels|curds|tender|appetizer|app\b|snack|small plate|bowl|soup|elote|churro|dessert|cheese|charcuterie|olives|bread|pretzel|pork|chicken|beef|steak|fish|tuna|salmon|octopus|mussel|clam|crab|lobster|veg|tofu|\bfood\b|\bgreens\b|\bmains?\b|entree|\bplates?\b|kitchen|\bsides?\b|starters?|\beats\b/i],
];

/**
 * @param {string} name item name
 * @param {string} sectionTitle the venue's own heading, used as a fallback
 *   signal — "Draft Beer" under "Drinks" is still beer, but a bare "Corralejo"
 *   under "Tequila" is only classifiable from the heading.
 */
export const MENU_CATEGORIES = [
  'beer', 'wine', 'cocktail', 'spirit', 'na_beverage', 'food', 'oysters', 'other',
];

function categoryFromRules(text) {
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(String(text || ''))) return category;
  }
  return null;
}

/**
 * Signals in order of how much we can verify them:
 *
 * 1. the item's own name — deterministic, auditable, and re-checkable long
 *    after the scrape, so it wins even over the model;
 * 2. the model's label — it read the whole menu and can place a house name
 *    like "Del Sol" that no keyword can, which is the case the rules cannot
 *    reach at all;
 * 3. the section heading;
 * 4. the section's other items (see `inferFromSectionNeighbours`).
 *
 * `source` is returned so a sync can report how much of the catalog is
 * categorized by rule versus by model, and where the two disagree.
 */
export function classifyCategoryWithSource(name, sectionTitle = '', modelCategory = null) {
  const byName = categoryFromRules(name);
  const fromModel = MENU_CATEGORIES.includes(modelCategory) && modelCategory !== 'other'
    ? modelCategory
    : null;

  if (byName) {
    return { category: byName, source: 'name', modelDisagrees: Boolean(fromModel && fromModel !== byName) };
  }
  if (fromModel) return { category: fromModel, source: 'model', modelDisagrees: false };

  const bySection = categoryFromRules(sectionTitle);
  if (bySection) return { category: bySection, source: 'section', modelDisagrees: false };
  return { category: 'other', source: 'unknown', modelDisagrees: false };
}

export function classifyCategory(name, sectionTitle = '', modelCategory = null) {
  return classifyCategoryWithSource(name, sectionTitle, modelCategory).category;
}

/**
 * Where an item sits on the menu is a stronger signal than its name.
 *
 * A house-invented drink ("Del Sol", "Transfusion") matches no keyword, and a
 * generic heading like "Drinks" or "$9 Items" adds nothing — but its
 * neighbours do: if the rest of that section is margaritas and mojitos, the
 * odd name is a cocktail too. So an unclassified item adopts the dominant
 * category of the items printed alongside it.
 *
 * Requires a real majority (and more than one classified neighbour) so a
 * genuinely mixed "Drinks" list of beers and cocktails stays `other` rather
 * than being confidently mislabelled.
 */
function inferFromSectionNeighbours(rows) {
  const counts = new Map();
  let classified = 0;
  for (const row of rows) {
    if (row.category === 'other') continue;
    counts.set(row.category, (counts.get(row.category) || 0) + 1);
    classified += 1;
  }
  if (classified < 2) return;

  const [dominant, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (count < 2 || count / classified < 0.6) return;
  for (const row of rows) {
    if (row.category !== 'other') continue;
    row.category = dominant;
    row.categorySource = 'neighbours';
  }
}

/** Flattens a listing's `hhMenu` into one row per offer, ready to insert. */
export function menuItemRows(hhMenu) {
  const rows = [];
  let sortOrder = 0;
  for (const section of hhMenu?.sections || []) {
    const sectionRows = [];
    for (const item of section.items || []) {
      const name = String(item?.name || '').trim();
      if (!name) continue;
      const priceText = String(item?.price || '').trim();
      const { category, source, modelDisagrees } = classifyCategoryWithSource(
        name,
        section.title,
        item?.category
      );
      sectionRows.push({
        sectionTitle: String(section.title || '').trim(),
        name,
        priceText,
        ...classifyPrice(priceText),
        category,
        categorySource: source,
        modelDisagrees,
        sortOrder: sortOrder++,
      });
    }
    inferFromSectionNeighbours(sectionRows);
    rows.push(...sectionRows);
  }
  return rows;
}
