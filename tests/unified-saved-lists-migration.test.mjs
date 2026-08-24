import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

async function apply(db, file) {
  await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
}

const db = new PGlite();
try {
  for (const file of [
    '0001_init.sql',
    '0002_venue_claims.sql',
    '0003_images.sql',
    '0004_venue_content.sql',
    '0005_photo_types.sql',
    '0006_auto_publish_photos.sql',
    '0007_live_promotions_foundation.sql',
    '0008_menu_item_gallery_choice.sql',
    '0009_venue_promotion_allowances.sql',
    '0010_promotion_images.sql',
    '0011_venue_managing_users.sql',
    '0012_collaborative_lists.sql',
  ]) await apply(db, file);

  const userId = '11111111-1111-4111-8111-111111111111';
  await db.query(`
    INSERT INTO users (id, name, email, password_salt, password_hash, share_id)
    VALUES ($1, 'Alex', 'alex@example.test', 'salt', 'hash', 'legacy-share')
  `, [userId]);
  await db.query(`
    INSERT INTO saved_spots (user_id, venue_id, status, note, rating, created_at, updated_at)
    VALUES
      ($1, 1, 'favorite', 'Great patio', 5, '2026-01-01', '2026-01-02'),
      -- Legacy clients could have left a rating behind while moving a spot to
      -- Want to Try. The unified migration must not carry that rating forward.
      ($1, 2, 'want-to-try', 'Order oysters', 3, '2026-02-01', '2026-02-02'),
      ($1, 3, 'been-to', '', 4, '2026-03-01', '2026-03-02')
  `, [userId]);
  await db.query(`
    INSERT INTO happy_hour_lists (owner_user_id, title, description)
    VALUES ($1, 'Existing custom list', '')
  `, [userId]);

  await apply(db, '0013_unified_saved_lists.sql');

  const lists = await db.query(`
    SELECT title, system_key, ratings_enabled, comments_enabled
    FROM happy_hour_lists WHERE owner_user_id = $1
    ORDER BY system_key NULLS LAST
  `, [userId]);
  assert.equal(lists.rows.length, 4);
  const byKey = new Map(lists.rows.map((row) => [row.system_key, row]));
  assert.equal(byKey.get('favorites').ratings_enabled, true);
  assert.equal(byKey.get('been_to').ratings_enabled, true);
  assert.equal(byKey.get('want_to_try').ratings_enabled, false);
  assert.equal(byKey.get('favorites').comments_enabled, true);

  const migratedItems = await db.query(`
    SELECT lists.system_key, items.venue_id
    FROM happy_hour_list_items items
    JOIN happy_hour_lists lists ON lists.id = items.list_id
    WHERE lists.owner_user_id = $1
    ORDER BY items.venue_id
  `, [userId]);
  assert.deepEqual(migratedItems.rows.map((row) => [row.system_key, row.venue_id]), [
    ['favorites', 1],
    ['want_to_try', 2],
    ['been_to', 3],
  ]);

  const feedback = await db.query(`
    SELECT items.venue_id, feedback.rating, feedback.comment
    FROM happy_hour_list_item_feedback feedback
    JOIN happy_hour_list_items items
      ON items.list_id = feedback.list_id AND items.venue_id = feedback.venue_id
    ORDER BY items.venue_id
  `);
  assert.deepEqual(feedback.rows.map((row) => [row.venue_id, row.rating, row.comment]), [
    [1, 5, 'Great patio'],
    [2, null, 'Order oysters'],
    [3, 4, ''],
  ]);

  const defaultList = await db.query(`
    SELECT lists.system_key
    FROM users JOIN happy_hour_lists lists ON lists.id = users.default_list_id
    WHERE users.id = $1
  `, [userId]);
  assert.equal(defaultList.rows[0].system_key, 'favorites');

  await assert.rejects(
    db.query(`UPDATE happy_hour_lists SET ratings_enabled = false WHERE owner_user_id = $1 AND system_key = 'favorites'`, [userId])
  );
  await assert.rejects(
    db.query(`UPDATE happy_hour_lists SET ratings_enabled = true WHERE owner_user_id = $1 AND system_key = 'want_to_try'`, [userId])
  );

  const favoritesId = (await db.query(`
    SELECT id FROM happy_hour_lists WHERE owner_user_id = $1 AND system_key = 'favorites'
  `, [userId])).rows[0].id;
  await assert.rejects(db.query(`
    INSERT INTO happy_hour_list_subscriptions (
      list_id, user_id, happy_hour_alerts_enabled, live_deal_alerts_enabled,
      channel_email, channel_text
    ) VALUES ($1, $2, false, false, true, false)
  `, [favoritesId, userId]));

  console.log('unified saved lists: migration, built-ins, feedback, defaults, and constraints passed');
} finally {
  await db.close();
}
