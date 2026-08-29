/**
 * Menu extraction from a page's own JSON API responses.
 *
 * Menu platforms (Popmenu, BentoBox, Toast, Square) render menus client-side
 * from JSON, and only render the section a visitor has selected. The DOM
 * therefore shows one section no matter how long we wait or how tall the
 * viewport is, while the JSON response that produced it already contains every
 * section and item. Reading the JSON is both more complete and cheaper than
 * driving the UI.
 *
 * The walk is shape-based, not platform-based: any object with a name and a
 * price is an item, and the nearest named ancestor is its section.
 */

const PRICE_KEYS = ['price', 'displayPrice', 'priceInCents', 'amount', 'cost'];
const MAX_DEPTH = 12;
const MAX_ITEMS = 300;
/** Keys whose subtrees are markup, styling or analytics rather than menu data. */
const SKIP_KEYS = /^(html|css|style|styles|theme|customCss|content|__typename|photo|photos|image|images|analytics|tracking)$/i;

function priceOf(node) {
  for (const key of PRICE_KEYS) {
    const raw = node[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      const dollars = key === 'priceInCents' ? raw / 100 : raw;
      if (dollars > 1000) return null;
      return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
    }
    if (typeof raw === 'string' && /\d/.test(raw) && raw.length <= 24) {
      return raw.trim().startsWith('$') ? raw.trim() : `$${raw.trim()}`;
    }
  }
  return null;
}

function nameOf(node) {
  const raw = node.name ?? node.title ?? node.itemName;
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 90) return null;
  return name;
}

/**
 * @param {unknown} root parsed JSON from a page response
 * @returns {{ section: string|null, items: { name: string, price: string }[] }[]}
 */
export function collectMenuGroupsFromJson(root) {
  const groups = new Map();
  const seen = new Set();
  let total = 0;

  const push = (section, name, price) => {
    const key = `${section || ''}|${name.toLowerCase()}`;
    if (seen.has(key) || total >= MAX_ITEMS) return;
    seen.add(key);
    total += 1;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push({ name, price });
  };

  const walk = (node, depth, section) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || total >= MAX_ITEMS) return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1, section);
      return;
    }
    const name = nameOf(node);
    const price = priceOf(node);
    if (name && price) {
      push(section, name, price);
      return;
    }
    // An unpriced named node that contains other nodes is a section heading.
    const nextSection = name || section;
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.test(key)) continue;
      if (value && typeof value === 'object') walk(value, depth + 1, nextSection);
    }
  };

  walk(root, 0, null);
  return [...groups.entries()].map(([section, items]) => ({ section, items }));
}

/** Renders extracted groups as plain text the page-text pipeline can consume. */
export function formatJsonMenuText(groups = []) {
  const blocks = [];
  for (const group of groups) {
    if (!group.items.length) continue;
    const lines = group.items.map((item) => `${item.name} ${item.price}`);
    blocks.push([group.section, ...lines].filter(Boolean).join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Extracts menu text from raw JSON response bodies collected off the network.
 * @param {{ url: string, body: string }[]} responses
 */
export function menuTextFromJsonResponses(responses = []) {
  const groups = new Map();
  for (const response of responses) {
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      continue;
    }
    for (const group of collectMenuGroupsFromJson(parsed)) {
      const existing = groups.get(group.section);
      if (!existing) {
        groups.set(group.section, group.items);
        continue;
      }
      const known = new Set(existing.map((item) => item.name.toLowerCase()));
      for (const item of group.items) {
        if (!known.has(item.name.toLowerCase())) existing.push(item);
      }
    }
  }
  return formatJsonMenuText([...groups.entries()].map(([section, items]) => ({ section, items })));
}
