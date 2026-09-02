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

  const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await db.query(`
    INSERT INTO users (id, name, email, password_salt, password_hash, share_id)
    VALUES
      ($1, 'Alex', 'alex@example.test', 'salt', 'hash', 'share-a'),
      ($2, 'Blake', 'blake@example.test', 'salt', 'hash', 'share-b')
  `, [userA, userB]);

  await apply(db, '0013_unified_saved_lists.sql');
  for (const file of [
    '0014_admin_user_intelligence.sql',
    '0015_merchant_reporting.sql',
    '0016_content_engine.sql',
    '0017_venue_publications.sql',
    '0018_happy_hour_menus.sql',
    '0019_submission_contact_relationship.sql',
    '0020_feedback_board.sql',
  ]) await apply(db, file);

  const favoritesA = (await db.query(`
    SELECT id FROM happy_hour_lists WHERE owner_user_id = $1 AND system_key = 'favorites'
  `, [userA])).rows[0].id;
  const beenToA = (await db.query(`
    SELECT id FROM happy_hour_lists WHERE owner_user_id = $1 AND system_key = 'been_to'
  `, [userA])).rows[0].id;
  const custom = (await db.query(`
    INSERT INTO happy_hour_lists (owner_user_id, title, description, comments_enabled)
    VALUES ($1, 'Friday Crew', '', true)
    RETURNING id
  `, [userA])).rows[0].id;
  const customTwo = (await db.query(`
    INSERT INTO happy_hour_lists (owner_user_id, title, description, comments_enabled)
    VALUES ($1, 'Saturday Crew', '', true)
    RETURNING id
  `, [userA])).rows[0].id;

  await db.query(`
    INSERT INTO happy_hour_list_items (list_id, venue_id, added_by_user_id)
    VALUES
      ($1, 10, $5),
      ($2, 10, $5),
      ($3, 10, $5),
      ($4, 10, $5),
      ($1, 20, $5)
  `, [favoritesA, beenToA, custom, customTwo, userA]);

  // Same user×venue across lists: latest rating wins; prefer non-empty comment.
  await db.query(`
    INSERT INTO happy_hour_list_item_feedback (
      list_id, venue_id, user_id, rating, comment, created_at, updated_at
    ) VALUES
      ($1, 10, $4, 5, '', '2026-01-01', '2026-01-01'),
      ($2, 10, $4, 2, 'older note', '2026-01-02', '2026-01-02'),
      ($3, 10, $4, 4, '', '2026-01-03', '2026-01-03'),
      ($1, 20, $4, NULL, 'solo comment', '2026-01-04', '2026-01-04')
  `, [favoritesA, beenToA, custom, userA]);

  // Collaborator independence: Blake's rows collapse separately across lists.
  await db.query(`
    INSERT INTO happy_hour_list_members (list_id, user_id, role)
    VALUES ($1, $3, 'editor'), ($2, $3, 'editor')
  `, [custom, customTwo, userB]);
  await db.query(`
    INSERT INTO happy_hour_list_item_feedback (
      list_id, venue_id, user_id, rating, comment, created_at, updated_at
    ) VALUES
      ($1, 10, $3, 1, 'blake first', '2026-02-01', '2026-02-01'),
      ($2, 10, $3, 3, '', '2026-02-02', '2026-02-02')
  `, [custom, customTwo, userB]);

  await apply(db, '0021_user_venue_feedback.sql');

  const globalRows = await db.query(`
    SELECT user_id::text AS user_id, venue_id, rating, comment
    FROM user_venue_feedback
    ORDER BY user_id, venue_id
  `);
  assert.deepEqual(globalRows.rows.map((row) => [row.user_id, row.venue_id, row.rating, row.comment]), [
    [userA, 10, 4, 'older note'],
    [userA, 20, null, 'solo comment'],
    [userB, 10, 3, 'blake first'],
  ]);

  // Removing a venue from a list must delete list notes but keep global feedback.
  await db.query(`
    INSERT INTO happy_hour_list_item_notes (list_id, venue_id, user_id, note)
    VALUES ($1, 10, $2, 'meet at 7')
  `, [custom, userA]);
  await db.query(`DELETE FROM happy_hour_list_items WHERE list_id = $1 AND venue_id = 10`, [custom]);
  const notesLeft = await db.query(`
    SELECT count(*)::int AS count FROM happy_hour_list_item_notes WHERE user_id = $1
  `, [userA]);
  assert.equal(notesLeft.rows[0].count, 0);
  const stillGlobal = await db.query(`
    SELECT rating, comment FROM user_venue_feedback WHERE user_id = $1 AND venue_id = 10
  `, [userA]);
  assert.deepEqual(stillGlobal.rows[0], { rating: 4, comment: 'older note' });

  await assert.rejects(db.query(`
    INSERT INTO user_venue_feedback (user_id, venue_id, rating, comment)
    VALUES ($1, 99, NULL, '')
  `, [userA]));

  console.log('user venue feedback: collapse rules, collaborator independence, and list-note cascade passed');
} finally {
  await db.close();
}
