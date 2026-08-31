#!/usr/bin/env node
// Audit deal and menu quality across the catalog.
//
// Two halves, deliberately separated. The first is mechanically fixable with no
// judgment: text that is not an offer, prices spelled three ways, a note that
// only restates the sections it sits above. `--apply` writes those.
//
// The second half is only ever reported. Every item in it needs a decision that
// costs something either way — removing a drink type makes a venue
// unfilterable, promoting a price off an evidence quote can publish a regular
// menu price as a happy-hour deal, and a window stored as 19:00-18:00 could be
// either a transposition or a genuine overnight. `--apply` does not touch them.
//
// Usage:
//   npm run audit:deals-menus              # report only
//   npm run audit:deals-menus -- --apply   # apply the safe half

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { inferDealTypes } from './lib/normalize.mjs';
import { MAX_DEAL_CHIPS } from './lib/deals.mjs';

const CHIP_MAX_CHARS = 42;
const ADDRESS_RE = /\b\d{2,6}\s+[A-Z][a-z]+.*\b(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Way|Ln|Lane|Ct|Suite|Ste)\b/;
const PHONE_RE = /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;
// Bracketed text on a menu is usually a dietary marker — [GF], [V] — so only
// an annotation long enough to be prose, or one that states an absence, counts
// as junk.
const MENU_JUNK_RE = /you have no products|\[empty page content\]|\[[^\]]{13,}\]|\[[^\]]*(?:no items|not listed|empty|unknown)[^\]]*\]/i;
const DANGLING_RE = /\s+(?:from|and|with|for|or|to|the|a|an|of|in|on|at|by|plus)$/i;
const CONTENTLESS_PRICE = /^(?:\$|n\/?a|not specified|unspecified|discounted|token|tbd|varies|market price|rotating specials?|happy hour pricing)$/i;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** One spelling per price value, so "$2 OFF"/"$2 Off"/"$2 off" stop being three. */
function canonicalPrice(raw) {
  let text = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (CONTENTLESS_PRICE.test(text)) return '';
  text = text.replace(/^(1\/2|half|½)\s+off$/i, '½ off');
  text = text.replace(/^(\$\d+(?:\.\d{2})?)\s+off$/i, (_, amount) => `${amount} off`);
  text = text.replace(/^(\d{1,3})\s*%\s+off$/i, (_, pct) => `${pct}% off`);
  return text;
}

function sectionTitles(menu) {
  return (menu?.sections || []).map((s) => String(s.title || '').toLowerCase());
}

/** A note that only names the sections below it tells the reader nothing. */
function noteRestatesSections(menu) {
  const note = String(menu?.note || '').trim();
  if (!note || note.length > 60) return false;
  const titles = sectionTitles(menu).filter(Boolean);
  if (titles.length < 2) return false;
  const words = note.toLowerCase().replace(/[^a-z& ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const filler = new Set(['happy', 'hour', 'and', 'the', 'our', 'menu', 'specials']);
  const meaningful = words.filter((w) => !filler.has(w));
  return meaningful.length > 0 && meaningful.every((w) => titles.some((t) => t.includes(w) || w.includes(t)));
}

const venues = readJson(HAPPY_HOURS_PATH, []);
const apply = process.argv.includes('--apply');
const safe = { addressDeal: [], containedDeal: [], danglingDeal: [], overCap: [], menuJunkItem: [], priceSpelling: [], contentlessPrice: [], restatedNote: [], dupMenuItem: [] };
const judgment = { tagsNoText: [], tagsContradicted: [], headTruncated: [], unknownWithPrice: [], swappedWindow: [], earlyWindow: [], overLongChip: [], emptyPublished: [], dayMismatch: [], staleMenuProvenance: [] };

for (const venue of venues) {
  const label = `${venue.name} (${venue.id})`;
  const deals = venue.deals || [];

  // ---- safe: deals that are not offers
  for (const deal of deals) {
    if (ADDRESS_RE.test(deal) || PHONE_RE.test(deal)) safe.addressDeal.push({ venue, deal });
    else if (DANGLING_RE.test(deal) || /-->/.test(deal)) safe.danglingDeal.push({ venue, deal });
  }
  for (const a of deals) for (const b of deals) {
    if (a !== b && b.toLowerCase().includes(a.toLowerCase())) safe.containedDeal.push({ venue, drop: a, keep: b });
  }
  if (deals.length > MAX_DEAL_CHIPS) safe.overCap.push({ venue, count: deals.length });

  // ---- safe: menu hygiene
  const menu = venue.hhMenu;
  if (menu?.sections?.length) {
    if (noteRestatesSections(menu)) safe.restatedNote.push({ venue, note: menu.note });
    const seen = new Set();
    for (const section of menu.sections) {
      for (const item of section.items || []) {
        if (MENU_JUNK_RE.test(item.name || '')) safe.menuJunkItem.push({ venue, name: item.name });
        const key = `${section.title}|${item.name}|${item.price || ''}`;
        if (seen.has(key)) safe.dupMenuItem.push({ venue, name: item.name });
        seen.add(key);
        const canon = canonicalPrice(item.price);
        if (item.price && !canon) safe.contentlessPrice.push({ venue, name: item.name, price: item.price });
        else if (item.price && canon !== item.price) safe.priceSpelling.push({ venue, from: item.price, to: canon });
      }
    }
    if (!menu.sourceUrl && !menu.observedAt) judgment.staleMenuProvenance.push({ venue });
  }

  // ---- judgment: dealTypes
  const stored = venue.dealTypes || [];
  if (stored.length && !deals.length) judgment.tagsNoText.push({ venue, stored });
  else if (deals.length && stored.length) {
    const derived = inferDealTypes(deals);
    const unsupported = stored.filter((t) => !derived.includes(t));
    if (derived.length && unsupported.length) judgment.tagsContradicted.push({ venue, stored, derived, unsupported });
  }

  // ---- judgment: truncation and recoverable offers
  for (const deal of deals) {
    if (/^[a-z]/.test(deal) && !/^\d/.test(deal)) judgment.headTruncated.push({ venue, deal });
    if (deal.length > CHIP_MAX_CHARS) judgment.overLongChip.push({ venue, deal });
  }
  if (venue.dealsUnknown) {
    const quotes = (venue.lastScrape?.evidence || []).filter((e) => e.field === 'deals' && /\$\s?\d/.test(e.quote || ''));
    if (quotes.length) judgment.unknownWithPrice.push({ venue, quote: quotes[0].quote });
  }

  // ---- judgment: windows
  const windows = venue.windows?.length ? venue.windows : (venue.startTime && venue.endTime && venue.days?.length ? [{ days: venue.days, startTime: venue.startTime, endTime: venue.endTime }] : []);
  for (const w of windows) {
    if (!CLOCK.test(w.startTime || '') || !CLOCK.test(w.endTime || '')) continue;
    const s = mins(w.startTime), e = mins(w.endTime);
    if (e < s && (24 * 60 - s) + e > 10 * 60) judgment.swappedWindow.push({ venue, w, hours: ((24 * 60 - s) + e) / 60 });
    else if (e > s && s < 8 * 60 && !w.allDay) judgment.earlyWindow.push({ venue, w });
  }
  const union = new Set((venue.windows || []).flatMap((w) => w.days || []));
  if (union.size && (venue.days || []).some((d) => !union.has(d)) === false && [...union].some((d) => !(venue.days || []).includes(d))) {
    judgment.dayMismatch.push({ venue, extra: [...union].filter((d) => !(venue.days || []).includes(d)) });
  }

  if (venue.listingStatus === 'published' && venue.dealsUnknown && !menu?.sections?.length && !(venue.galleryImages || []).length) {
    judgment.emptyPublished.push({ venue });
  }
}

function report(title, groups) {
  console.log(`\n${title}`);
  for (const [name, list] of Object.entries(groups)) {
    const venueCount = new Set(list.map((x) => x.venue.id)).size;
    console.log(`  ${String(list.length).padStart(5)} finding(s) / ${String(venueCount).padStart(4)} venue(s)  ${name}`);
  }
}

console.log(`Catalog: ${venues.length} listings.`);
report('SAFE — mechanically fixable, applied with --apply:', safe);
report('JUDGMENT — reported only, never changed by this script:', judgment);

console.log('\nExamples:');
for (const [name, list] of [...Object.entries(safe), ...Object.entries(judgment)]) {
  if (!list.length) continue;
  console.log(`\n  ${name}:`);
  for (const item of list.slice(0, 4)) {
    const extra = item.deal || item.name || item.note || item.quote || (item.w && `${item.w.startTime}-${item.w.endTime}`) || (item.stored && `stored=${JSON.stringify(item.stored)} derived=${JSON.stringify(item.derived || [])}`) || (item.from && `${item.from} -> ${item.to}`) || (item.extra && item.extra.join(',')) || '';
    console.log(`    ${item.venue.name} (${item.venue.id}) ${String(extra).slice(0, 100)}`);
  }
}

if (!apply) {
  console.log('\nReport only — pass --apply to write the safe half.');
  process.exit(0);
}

// ---- apply the safe half
let touched = 0;
for (const venue of venues) {
  let dirty = false;
  let deals = venue.deals || [];
  const before = JSON.stringify(deals);

  deals = deals.filter((d) => !(ADDRESS_RE.test(d) || PHONE_RE.test(d)));
  deals = deals.map((d) => d.replace(/\s*-->\s*$/, '').replace(DANGLING_RE, '').trim()).filter(Boolean);
  // Drop a chip that is wholly contained in a longer, more specific one.
  deals = deals.filter((a) => !deals.some((b) => b !== a && b.toLowerCase().includes(a.toLowerCase())));
  deals = [...new Set(deals)].slice(0, MAX_DEAL_CHIPS);
  if (JSON.stringify(deals) !== before) { venue.deals = deals; dirty = true; }

  const menu = venue.hhMenu;
  if (menu?.sections?.length) {
    if (noteRestatesSections(menu)) { delete menu.note; dirty = true; }
    for (const section of menu.sections) {
      const seen = new Set();
      const items = [];
      for (const item of section.items || []) {
        if (MENU_JUNK_RE.test(item.name || '')) { dirty = true; continue; }
        const key = `${item.name}|${item.price || ''}`;
        if (seen.has(key)) { dirty = true; continue; }
        seen.add(key);
        const canon = canonicalPrice(item.price);
        if (item.price !== undefined && canon !== item.price) {
          if (canon) item.price = canon; else delete item.price;
          dirty = true;
        }
        items.push(item);
      }
      section.items = items;
    }
    menu.sections = menu.sections.filter((s) => s.items.length);
    if (!menu.sections.length) { delete venue.hhMenu; dirty = true; }
  }
  if (dirty) touched += 1;
}

writeJson(HAPPY_HOURS_PATH, venues);
console.log(`\nApplied the safe half to ${touched} listing(s). Wrote ${HAPPY_HOURS_PATH}`);
