#!/usr/bin/env node
// Project the transcribed happy-hour menus in public/data/happy-hours.json
// into the queryable `happy_hour_menus` / `happy_hour_menu_items` tables.
//
// The JSON file stays the source of truth — it renders the site and the menu
// boards. This makes the same data answerable by query ("cocktails under $8 in
// North Park", "how did wing prices move") instead of by loading 611 nested
// documents, and gives later AI analysis a real corpus to read.
//
// Idempotent: a venue's items are replaced wholesale, so re-running after a
// re-scrape is safe and removes items the venue dropped.
//
// Usage:
//   npm run menus:sync                 # dry run, reports what would change
//   npm run menus:sync -- --apply
//   npm run menus:sync -- --apply --venue=398,12

import pg from 'pg';
import { HAPPY_HOURS_PATH } from './import-google-venues/lib/constants.mjs';
import { readJson } from './import-google-venues/lib/io.mjs';
import { menuItemRows } from './import-google-venues/lib/menu-item-classify.mjs';

function parseSyncArgs(argv) {
  const options = { apply: false, venue: null };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--venue=')) options.venue = arg.slice(8);
  }
  return options;
}

function isLocalConnection(connectionString) {
  return /\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
}

function venuesWithMenus(venues, options) {
  let todo = venues.filter((venue) => venue.hhMenu?.sections?.length);
  if (options.venue) {
    const keys = new Set(String(options.venue).split(',').map((part) => part.trim()));
    todo = todo.filter((venue) => keys.has(String(venue.id)));
  }
  return todo;
}

async function main() {
  const options = parseSyncArgs(process.argv.slice(2));
  const venues = readJson(HAPPY_HOURS_PATH, []);
  const todo = venuesWithMenus(venues, options);

  const totals = {
    venues: todo.length,
    items: 0,
    priced: 0,
    disagreements: 0,
    byCategory: new Map(),
    bySource: new Map(),
  };
  const payload = todo.map((venue) => {
    const rows = menuItemRows(venue.hhMenu);
    totals.items += rows.length;
    for (const row of rows) {
      if (row.priceAmount !== null) totals.priced += 1;
      if (row.modelDisagrees) totals.disagreements += 1;
      totals.byCategory.set(row.category, (totals.byCategory.get(row.category) || 0) + 1);
      totals.bySource.set(row.categorySource, (totals.bySource.get(row.categorySource) || 0) + 1);
    }
    return { venue, rows };
  });

  console.log(`${totals.venues} listing(s) with a transcribed menu, ${totals.items} item(s).`);
  console.log(`  ${totals.priced} item(s) have a comparable price.`);
  console.log('\nCategory:');
  for (const [category, count] of [...totals.byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${category}`);
  }
  // How much of the corpus is categorized by a rule we can re-check versus by
  // the model's reading, and how often the two disagree on the same item.
  console.log('\nCategorized by:');
  for (const [source, count] of [...totals.bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${source}`);
  }
  console.log(`\n  ${totals.disagreements} item(s) where the model disagreed with a keyword rule (rule kept).`);

  if (!options.apply) {
    console.log('\nDry run — pass --apply to write to the database.');
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. See README-NEON-MIGRATION.md.');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString,
    ssl: isLocalConnection(connectionString) ? false : { rejectUnauthorized: true },
    max: 4,
  });

  const client = await pool.connect();
  let written = 0;
  try {
    for (const { venue, rows } of payload) {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO happy_hour_menus
             (venue_id, venue_name, neighborhood, note, windows, source_url, scraped_at, item_count, synced_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, now())
           ON CONFLICT (venue_id) DO UPDATE SET
             venue_name = EXCLUDED.venue_name,
             neighborhood = EXCLUDED.neighborhood,
             note = EXCLUDED.note,
             windows = EXCLUDED.windows,
             source_url = EXCLUDED.source_url,
             scraped_at = EXCLUDED.scraped_at,
             item_count = EXCLUDED.item_count,
             synced_at = now()`,
          [
            venue.id,
            venue.name || '',
            venue.neighborhood || '',
            venue.hhMenu.note || '',
            JSON.stringify(venue.windows || []),
            venue.hhMenu.sourceUrl || venue.website || '',
            venue.hhMenu.observedAt || null,
            rows.length,
          ]
        );

        // Replace rather than merge: a re-scrape is the authority on what the
        // venue currently offers, including what it stopped offering.
        await client.query('DELETE FROM happy_hour_menu_items WHERE venue_id = $1', [venue.id]);
        for (const row of rows) {
          await client.query(
            `INSERT INTO happy_hour_menu_items
               (venue_id, section_title, name, price_text, price_kind, price_amount,
                price_amount_max, discount_amount, discount_percent, category, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              venue.id,
              row.sectionTitle,
              row.name,
              row.priceText,
              row.priceKind,
              row.priceAmount,
              row.priceAmountMax,
              row.discountAmount,
              row.discountPercent,
              row.category,
              row.sortOrder,
            ]
          );
        }
        await client.query('COMMIT');
        written += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        console.warn(`  ! ${venue.name} (${venue.id}): ${error.message}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\nSynced ${written} of ${payload.length} listing(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
