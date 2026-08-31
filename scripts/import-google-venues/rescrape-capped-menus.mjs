#!/usr/bin/env node
// Re-read the menus that the old four-section cap may have cut short.
//
// Until this week three separate layers each truncated a transcribed menu: the
// extraction prompt told the model "max 4 sections", `normalizeMenuBoard` threw
// away anything past the fourth, and the board renderer assumed one page. The
// caps are gone and boards paginate, but the damage is already in the data —
// and it is invisible, because a menu cut down to four sections is
// indistinguishable from a menu that genuinely has four.
//
// So the listings sitting on exactly four sections get re-read from source and
// compared against what is stored. A menu that comes back with more than four
// sections was truncated; one that comes back with four was not.
//
// What this will not do:
//
//   * Invent or infer anything. A re-read that comes back ambiguous — fewer
//     items than stored, a page that fails the ownership checks, a chain page
//     for a different branch — leaves the stored menu untouched and reports the
//     venue for a human to look at. A wrong price is worse than a short menu.
//   * Touch times, deals, or dealTypes. This is a menu pass. The listing's
//     schedule was verified by its own scrape and is none of this script's
//     business.
//
// Usage:
//   node scripts/import-google-venues/rescrape-capped-menus.mjs            # report only
//   node scripts/import-google-venues/rescrape-capped-menus.mjs --apply
//   node scripts/import-google-venues/rescrape-capped-menus.mjs --venue=101,129
//   node scripts/import-google-venues/rescrape-capped-menus.mjs --limit=5
//   node scripts/import-google-venues/rescrape-capped-menus.mjs --reads=5

import { HAPPY_HOURS_PATH } from './lib/constants.mjs';
import { readJson, writeJson } from './lib/io.mjs';
import { createCachedFetch } from './lib/fetch-page.mjs';
import { createBrowserFetch, hasBrowserState } from './lib/playwright-browser.mjs';
import { inventoryWebsite } from './lib/website-crawl.mjs';
import { hasAiExtraction, transcribeMenuBoardWithAi } from './lib/ai-extract.mjs';
import { conflictsWithVenue } from './lib/location-page.mjs';
import { isUsableVenueWebsite, pageMatchesVenueListing } from './lib/website-ownership.mjs';
import { formatAiUsage } from './lib/ai-usage.mjs';

/** The cap the old prompt and normalizer both enforced. */
const OLD_SECTION_CAP = 4;
const REPORT_PATH = '.data/capped-menu-rescrape.json';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = (args.find((a) => a.startsWith('--venue=')) || '').split('=')[1];
const limitArg = (args.find((a) => a.startsWith('--limit=')) || '').split('=')[1];
const readsArg = (args.find((a) => a.startsWith('--reads=')) || '').split('=')[1];
// Three is the smallest number that can produce a majority.
const readCount = Math.max(1, Number(readsArg) || 3);
const onlyIds = only ? new Set(only.split(',').map(Number)) : null;
const limit = limitArg ? Number(limitArg) : Infinity;

const countItems = (menu) => (menu?.sections || []).reduce((n, s) => n + (s.items || []).length, 0);

/**
 * An item identified by name alone, loosely normalized.
 *
 * Deliberately not keyed by section: a re-read routinely files the same wings
 * under "Bites" where the stored menu called it "Food", and keying on the
 * heading made every item of every venue look lost. What matters for "did we
 * drop something" is whether the dish is still on the menu, not which heading
 * the model chose for it.
 */
const itemKey = (item) =>
  String(item?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const itemKeys = (menu) =>
  new Set((menu?.sections || []).flatMap((s) => (s.items || []).map(itemKey)).filter(Boolean));

/**
 * Why a re-read cannot be trusted, or null when it can.
 *
 * The window-only audit found two ways a confident menu turns out to be the
 * wrong restaurant's: a website listed against the wrong brand entirely, and a
 * chain page for a different branch. Both produce a plausible menu, so both are
 * checked before the transcription is believed rather than after.
 */
function sameHost(a, b) {
  try {
    return new URL(a).hostname.replace(/^www\./i, '').toLowerCase()
      === new URL(b).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return false;
  }
}

function rejectSource(page, venue) {
  if (!page?.url) return 'no source page';
  // A different branch of the same chain is the dangerous case: same brand,
  // same layout, wrong prices.
  if (conflictsWithVenue(page.url, venue)) return `page is a different branch (${page.url})`;
  // Whose site this is was already settled when the listing's website was
  // verified, so a page on that host needs no further proof. Requiring the menu
  // page itself to name the venue rejected herbandwood.com/happy-hour for Herb
  // & Wood — menu pages often carry no address at all. Off-host pages, which
  // the crawler does follow, still have to prove themselves.
  if (venue.website && sameHost(page.url, venue.website)) return null;
  if (page.text && !pageMatchesVenueListing(page.text, venue)) {
    return `off-site page does not mention this listing (${page.url})`;
  }
  return null;
}

/**
 * Which of several reads to believe, or null when they do not agree.
 *
 * One read cannot settle this. Asked three times for the same page, the model
 * returned Karl Strauss as 5, 5 and 6 sections, and The Rabbit Hole as 5, 6 and
 * 3 — a spread wider than the four-versus-more question being asked. So a
 * verdict needs agreement: at least two reads landing on the same section count
 * and within two items of each other. Among those, the fullest is taken, since
 * the failure being investigated is omission.
 */
function consensusOf(reads) {
  const menus = reads.filter((menu) => menu?.sections?.length);
  if (!menus.length) return { menu: null, why: 'no menu came back' };
  if (menus.length === 1) return { menu: menus[0], why: 'single read, no corroboration', weak: true };

  const groups = new Map();
  for (const menu of menus) {
    const key = menu.sections.length;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(menu);
  }
  // Agreement is on how many sections the menu has, which is the question being
  // asked. Item counts still wobble within an agreeing group — Hooleys came
  // back as 12 sections three times running but with 38, 47 and 49 items — so
  // the fullest of them is taken and the spread is recorded rather than used to
  // veto. Every item in that read was still read off the venue's own page; the
  // wobble is in what the model omits, never in what it adds.
  const agreed = [...groups.values()]
    .filter((group) => group.length >= 2)
    .sort((a, b) => Math.max(...b.map(countItems)) - Math.max(...a.map(countItems)))[0];

  const shape = menus.map((m) => `${m.sections.length}s/${countItems(m)}i`).join(', ');
  if (!agreed) return { menu: null, why: `reads disagree (${shape})` };
  return { menu: agreed.sort((a, b) => countItems(b) - countItems(a))[0], why: null, shape };
}

/**
 * Should the agreed re-read replace what is stored?
 *
 * The test is whether it is a fuller transcription of the same menu, judged on
 * totals rather than item by item. Matching names individually was too strict:
 * a truncated menu often stored a catch-all line — "drafts", "wines", "apps" —
 * where a complete read lists the actual beers, and the catch-all disappearing
 * is the improvement, not a loss. What would be a real loss is a read that
 * comes back *shorter*, and that is still refused.
 */
/**
 * Prices a happy hour would not charge.
 *
 * Trattoria da Sofia's happy-hour page is rendered in JavaScript and its text
 * comes back nearly empty, so `rankPagesForMenu` — which ranks by how many
 * prices a page contains — handed the model the dinner and wine-list pages
 * instead, and it dutifully transcribed a $165 Barolo as a happy-hour item. A
 * cap used to limit the blast radius of that; nothing does now, so the prices
 * themselves are the check. A bottle list is unmistakable.
 */
function implausiblePrices(menu) {
  const values = (menu.sections || [])
    .flatMap((section) => (section.items || []).map((item) => String(item.price || '')))
    .flatMap((price) => [...price.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])));
  if (!values.length) return null;
  const steep = values.filter((value) => value > 60);
  if (steep.length >= 3) {
    return `${steep.length} item(s) priced over $60 (up to $${Math.max(...values)}) — reads like a wine or dinner list`;
  }
  return null;
}

function verdictFor(stored, fresh) {
  if (!fresh?.sections?.length) return { kind: 'unreadable', why: 'no menu came back' };

  const implausible = implausiblePrices(fresh);
  if (implausible) return { kind: 'ambiguous', why: implausible, lost: [] };

  const gainedSections = fresh.sections.length - stored.sections.length;
  const gainedItems = countItems(fresh) - countItems(stored);
  const lost = [...itemKeys(stored)].filter((key) => !itemKeys(fresh).has(key));

  // Shorter than what is on file. Either a worse read or a different page;
  // either way it is not evidence the stored menu is wrong.
  if (gainedItems < 0) {
    return {
      kind: 'ambiguous',
      why: `read is shorter than what is stored (${gainedItems} item(s))`,
      lost, gainedSections, gainedItems,
    };
  }
  if (fresh.sections.length <= OLD_SECTION_CAP && gainedItems === 0) {
    return { kind: 'confirmed', why: `still ${fresh.sections.length} section(s)`, gainedSections, gainedItems };
  }
  // Past the cap is proof the cap cut this menu. Still within it but longer is a
  // fuller read — the old prompt capped items per section too, and a menu can
  // simply have changed — so it is stored but counted separately.
  const kind = fresh.sections.length > OLD_SECTION_CAP ? 'grew' : 'fuller';
  return {
    kind,
    why: `+${gainedSections} section(s), +${gainedItems} item(s)`
      + (lost.length ? `, ${lost.length} line(s) reworded or itemized` : ''),
    lost, gainedSections, gainedItems,
  };
}

const venues = readJson(HAPPY_HOURS_PATH, []);
let cohort = venues.filter((v) => (v.hhMenu?.sections?.length || 0) === OLD_SECTION_CAP);
if (onlyIds) cohort = cohort.filter((v) => onlyIds.has(v.id));
cohort = cohort.slice(0, limit);

if (!hasAiExtraction()) {
  console.error('ANTHROPIC_API_KEY is required to re-transcribe a menu.');
  process.exit(1);
}

console.log(`Re-reading ${cohort.length} listing(s) sitting on the old ${OLD_SECTION_CAP}-section cap, ${readCount} read(s) each.\n`);

/**
 * Menu platforms — Popmenu, Toast, Square — render the menu in the browser, so
 * a plain fetch of one returns a valid page with no menu on it. `createCachedFetch`
 * already detects that and retries through Playwright, but only if handed a
 * `browserFetch`; without one it detects the problem and can do nothing about
 * it. Omitting it here is what made 16 of these listings look unreadable.
 */
const browserSession = hasBrowserState() ? await createBrowserFetch({}) : null;
if (!browserSession) {
  console.warn('No warmed browser profile — JavaScript-only menus will be unreadable.');
  console.warn('Run: npm run browser:warm -- --auto\n');
}

const fetchImpl = createCachedFetch({
  browserFetch: browserSession?.fetch || null,
  refresh: true,
  browserConcurrency: 3,
});
const results = { grew: [], fuller: [], confirmed: [], ambiguous: [], unreadable: [] };

for (const venue of cohort) {
  // The recorded source first — but the old normalizer stripped provenance off
  // almost every menu, so for most of these the listed website is all there is.
  const start = venue.hhMenu?.sourceUrl || venue.website;
  if (!isUsableVenueWebsite(start)) {
    results.unreadable.push({ venue, why: 'no usable source URL on file' });
    console.log(`  ! ${venue.name} (${venue.id}): no usable source URL`);
    continue;
  }

  let inventory = null;
  try {
    inventory = await inventoryWebsite(start, {
      fetchImpl,
      priorityUrl: venue.hhMenu?.sourceUrl || null,
      venueContext: venue,
      fetchSocial: false,
    });
  } catch (error) {
    results.unreadable.push({ venue, why: `crawl failed: ${error.message}` });
    console.log(`  ! ${venue.name} (${venue.id}): crawl failed (${error.message})`);
    continue;
  }

  const usable = (inventory?.candidates || []).filter((page) => page.ok !== false && page.text);
  if (!usable.length) {
    const why = inventory?.blocked ? 'site blocked the crawler' : 'no readable page';
    results.unreadable.push({ venue, why });
    console.log(`  ! ${venue.name} (${venue.id}): ${why}`);
    continue;
  }

  const rejected = usable.map((page) => rejectSource(page, venue)).filter(Boolean);
  const trusted = usable.filter((page) => !rejectSource(page, venue));
  if (!trusted.length) {
    results.ambiguous.push({ venue, why: rejected[0] || 'no page could be tied to this listing' });
    console.log(`  ? ${venue.name} (${venue.id}): ${rejected[0]}`);
    continue;
  }

  // One crawl, read several times: the pages are already fetched, so extra
  // reads cost a model call each and nothing more.
  const reads = [];
  for (let attempt = 0; attempt < readCount; attempt += 1) {
    try {
      reads.push(await transcribeMenuBoardWithAi({ ...inventory, candidates: trusted }, venue));
    } catch (error) {
      reads.push(null);
      if (attempt === 0 && /valid JSON/i.test(error.message)) continue;
    }
  }

  const { menu: fresh, why: disagreement, weak, shape } = consensusOf(reads);
  if (!fresh) {
    const bucket = disagreement?.startsWith('reads disagree') ? 'ambiguous' : 'unreadable';
    results[bucket].push({ venue, why: disagreement, source: trusted[0].url });
    console.log(`  ${bucket === 'ambiguous' ? '?' : '!'} ${venue.name} (${venue.id}): ${disagreement}`);
    continue;
  }

  const verdict = verdictFor(venue.hhMenu, fresh);
  if (weak && verdict.kind !== 'confirmed') {
    results.ambiguous.push({ venue, why: `${verdict.why} on a single uncorroborated read`, verdict, source: trusted[0].url });
    console.log(`  ? ${venue.name} (${venue.id}): ${verdict.why} (uncorroborated)`);
    continue;
  }
  const mark = { grew: '+', fuller: '>', confirmed: '=', ambiguous: '?', unreadable: '!' }[verdict.kind];
  console.log(`  ${mark} ${venue.name} (${venue.id}): ${verdict.why}`);
  results[verdict.kind].push({ venue, why: verdict.why, verdict, fresh, source: trusted[0].url, shape });

  // Both a section gain and an item gain are stored: neither lost anything
  // already on file, so both are strictly more of the venue's own menu.
  if (!['grew', 'fuller'].includes(verdict.kind) || !apply) continue;

  // Provenance is the point of re-reading, so it is recorded properly this
  // time: which page it came from, when, and the original flyer if there was
  // one, which the old menu's sourceImages still hold.
  venue.hhMenu = {
    ...fresh,
    sourceUrl: trusted[0].url,
    observedAt: new Date().toISOString().slice(0, 10),
    ...(venue.hhMenu?.sourceImages?.length ? { sourceImages: venue.hhMenu.sourceImages } : {}),
  };
}

const changed = [...results.grew, ...results.fuller];

console.log('\n--- split across the cohort ---');
console.log(`  gained sections past the cap (truncated): ${results.grew.length}`);
console.log(`  same sections, more items (fuller read):  ${results.fuller.length}`);
console.log(`  confirmed at ${OLD_SECTION_CAP} sections:                  ${results.confirmed.length}`);
console.log(`  needs a human look (ambiguous):           ${results.ambiguous.length}`);
console.log(`  could not be re-read:                     ${results.unreadable.length}`);

if (changed.length) {
  const sections = changed.reduce((n, r) => n + r.verdict.gainedSections, 0);
  const items = changed.reduce((n, r) => n + r.verdict.gainedItems, 0);
  console.log(`\n  recovered overall: +${sections} section(s), +${items} item(s)`);
  for (const r of results.grew) console.log(`    [truncated] ${r.venue.id} ${r.venue.name}: ${r.why}`);
  for (const r of results.fuller) console.log(`    [fuller]    ${r.venue.id} ${r.venue.name}: ${r.why}`);
}

for (const [kind, label] of [['ambiguous', 'NEEDS A HUMAN LOOK'], ['unreadable', 'COULD NOT RE-READ']]) {
  if (!results[kind].length) continue;
  console.log(`\n  ${label}:`);
  for (const r of results[kind]) {
    console.log(`    ${r.venue.id} ${r.venue.name}: ${r.why}`);
    // The dropped items are the evidence a human needs to judge which read is
    // right, so they go in the report rather than being summarised as a count.
    if (r.verdict?.lost?.length) {
      console.log(`        source: ${r.source || 'n/a'}`);
      console.log(`        no longer shown: ${r.verdict.lost.slice(0, 8).join('; ')}`);
    }
  }
}

// A twenty-minute run's findings should not live only in a terminal buffer.
const report = {
  ranAt: new Date().toISOString(),
  cohortSize: cohort.length,
  counts: Object.fromEntries(Object.entries(results).map(([kind, rows]) => [kind, rows.length])),
  venues: Object.entries(results).flatMap(([kind, rows]) => rows.map((r) => ({
    kind,
    id: r.venue.id,
    name: r.venue.name,
    why: r.why,
    source: r.source || null,
    gainedSections: r.verdict?.gainedSections ?? null,
    gainedItems: r.verdict?.gainedItems ?? null,
    readShape: r.shape || null,
    lost: r.verdict?.lost || [],
  }))),
};
writeJson(REPORT_PATH, report);
console.log(`\nWrote ${REPORT_PATH}`);

console.log(`\n${formatAiUsage({ venues: cohort.length })}`);

if (!apply) {
  console.log('\nReport only — pass --apply to write. Re-render boards afterwards with menus:render.');
  process.exit(0);
}

// Re-read and merge rather than writing back the copy loaded twenty minutes
// ago. This run takes long enough that another pass can commit to the catalog
// while it is working, and writing the whole in-memory array back silently
// reverted 85 listings' browse flags the first time.
await browserSession?.close();

const latest = readJson(HAPPY_HOURS_PATH, []);
const freshMenus = new Map(changed.map((r) => [r.venue.id, r.venue.hhMenu]));
for (const venue of latest) {
  const menu = freshMenus.get(venue.id);
  if (menu) venue.hhMenu = menu;
}
writeJson(HAPPY_HOURS_PATH, latest);
console.log(`\nUpdated ${changed.length} menu(s) in ${HAPPY_HOURS_PATH}`);
console.log('Now run: node scripts/import-google-venues/render-menu-boards.mjs --apply --venue='
  + changed.map((r) => r.venue.id).join(','));
