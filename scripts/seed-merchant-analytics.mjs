#!/usr/bin/env node
// Insert realistic merchant analytics bot traffic for local report UI testing.
//
// Usage:
//   npm run seed:merchant-analytics
//   VENUE_ID=21 DAYS=90 VISITORS=120 npm run seed:merchant-analytics
//   npm run seed:merchant-analytics -- --with-audience
//   npm run seed:merchant-analytics -- --clear
//
// Seeded analytics rows use properties.seed = true. Seeded audience users use
// users.metadata.seed = "merchant_analytics". --clear removes both.

import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const AUTHENTICATED_SHARE = 0.32;
const REFERRERS = ['google.com', 'instagram.com', 'facebook.com', 'reddit.com', 'direct', 'bing.com'];
const BUILTIN_LISTS = [
  { systemKey: 'favorites', title: 'Favorites', ratingsEnabled: true },
  { systemKey: 'want_to_try', title: 'Want to Try', ratingsEnabled: false },
  { systemKey: 'been_to', title: 'Been To', ratingsEnabled: true },
];

function parseArgs(argv) {
  const options = {
    venueId: Number(process.env.VENUE_ID || 21),
    days: Number(process.env.DAYS || 90),
    visitors: Number(process.env.VISITORS || 120),
    audienceSize: Number(process.env.AUDIENCE || 35),
    clear: false,
    withAudience: false,
  };
  for (const arg of argv) {
    if (arg === '--clear') options.clear = true;
    else if (arg === '--with-audience') options.withAudience = true;
    else if (arg.startsWith('--venue=')) options.venueId = Number(arg.slice(8));
    else if (arg.startsWith('--days=')) options.days = Number(arg.slice(7));
    else if (arg.startsWith('--visitors=')) options.visitors = Number(arg.slice(11));
    else if (arg.startsWith('--audience=')) options.audienceSize = Number(arg.slice(11));
  }
  return options;
}

function isLocalConnection(connectionString) {
  return /\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pickWeighted(items) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item.value;
  }
  return items[items.length - 1].value;
}

function dayOffsetMs(daysAgo, hour = 12, minute = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  date.setUTCHours(hour, minute, randomInt(0, 59), randomInt(0, 999));
  return date.toISOString();
}

function seedMetadata(venueId) {
  return JSON.stringify({ seed: 'merchant_analytics', seed_venue_id: venueId });
}

async function clearSeededData(client, venueId) {
  const deletedEvents = await client.query(
    `DELETE FROM merchant_analytics_events
     WHERE venue_id = $1 AND COALESCE(properties->>'seed', 'false') = 'true'`,
    [venueId]
  );

  const seedUsers = await client.query(
    `SELECT id FROM users
     WHERE metadata->>'seed' = 'merchant_analytics'
       AND metadata->>'seed_venue_id' = $1`,
    [String(venueId)]
  );
  const userIds = seedUsers.rows.map((row) => row.id);
  let deletedFollows = 0;
  let deletedItems = 0;
  let deletedUsers = 0;
  if (userIds.length) {
    const follows = await client.query(
      `DELETE FROM venue_follows WHERE venue_id = $1 AND user_id = ANY($2::uuid[])`,
      [venueId, userIds]
    );
    deletedFollows = follows.rowCount;
    const items = await client.query(
      `DELETE FROM happy_hour_list_items
       WHERE venue_id = $1 AND added_by_user_id = ANY($2::uuid[])`,
      [venueId, userIds]
    );
    deletedItems = items.rowCount;
    const users = await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds]);
    deletedUsers = users.rowCount;
  }

  console.log(
    `Removed ${deletedEvents.rowCount} seeded events, ${deletedFollows} follows, ${deletedItems} saves, and ${deletedUsers} bot users for venue ${venueId}.`
  );
}

async function createSeedUser(client, venueId, index) {
  const email = `bot-analytics-v${venueId}-${String(index).padStart(3, '0')}@seed.local`;
  const shareId = crypto.randomUUID();
  const inserted = await client.query(
    `INSERT INTO users (name, email, password_salt, password_hash, share_id, metadata)
     VALUES ($1, $2, 'seed', 'seed', $3, $4::jsonb)
     ON CONFLICT (lower(email)) DO UPDATE SET metadata = EXCLUDED.metadata
     RETURNING id`,
    [`Analytics Bot ${index}`, email, shareId, seedMetadata(venueId)]
  );
  const userId = inserted.rows[0].id;

  for (const list of BUILTIN_LISTS) {
    await client.query(
      `INSERT INTO happy_hour_lists (
         owner_user_id, title, description, system_key, ratings_enabled, comments_enabled
       ) VALUES ($1, $2, '', $3, $4, true)
       ON CONFLICT (owner_user_id, system_key) WHERE system_key IS NOT NULL DO NOTHING`,
      [userId, list.title, list.systemKey, list.ratingsEnabled]
    );
  }

  const favorites = await client.query(
    `SELECT id FROM happy_hour_lists
     WHERE owner_user_id = $1 AND system_key = 'favorites'
     LIMIT 1`,
    [userId]
  );
  const favoritesListId = favorites.rows[0]?.id;
  if (favoritesListId) {
    await client.query(
      `UPDATE users SET default_list_id = $1 WHERE id = $2 AND default_list_id IS NULL`,
      [favoritesListId, userId]
    );
  }

  return { userId, favoritesListId };
}

async function loadSeedUsers(client, venueId) {
  const rows = await client.query(
    `SELECT u.id AS user_id,
            favorites.id AS favorites_list_id
     FROM users u
     LEFT JOIN happy_hour_lists favorites
       ON favorites.owner_user_id = u.id AND favorites.system_key = 'favorites'
     WHERE u.metadata->>'seed' = 'merchant_analytics'
       AND u.metadata->>'seed_venue_id' = $1
     ORDER BY u.email`,
    [String(venueId)]
  );
  return rows.rows.map((row) => ({
    userId: row.user_id,
    favoritesListId: row.favorites_list_id,
  }));
}

async function ensureAnalyticsUsers(client, venueId, count) {
  let users = await loadSeedUsers(client, venueId);
  for (let index = users.length; index < count; index += 1) {
    users.push(await createSeedUser(client, venueId, index + 1));
  }
  return users;
}

async function seedAudience(client, venueId, userRecords) {
  for (const [index, user] of userRecords.entries()) {
    const roll = Math.random();
    const channelEmail = roll < 0.82 || roll >= 0.92;
    const channelText = roll >= 0.82;
    const happyHourAlerts = roll < 0.58;
    const promotionAlerts = roll >= 0.35 && roll < 0.88;

    if (happyHourAlerts || promotionAlerts || roll >= 0.2) {
      await client.query(
        `INSERT INTO venue_follows (
           user_id, venue_id, happy_hour_alerts_enabled, promotion_alerts_enabled,
           channel_email, channel_text
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, venue_id) DO UPDATE SET
           happy_hour_alerts_enabled = EXCLUDED.happy_hour_alerts_enabled,
           promotion_alerts_enabled = EXCLUDED.promotion_alerts_enabled,
           channel_email = EXCLUDED.channel_email,
           channel_text = EXCLUDED.channel_text`,
        [user.userId, venueId, happyHourAlerts, promotionAlerts, channelEmail, channelText]
      );
    }

    if (user.favoritesListId && roll < 0.72) {
      await client.query(
        `INSERT INTO happy_hour_list_items (list_id, venue_id, added_by_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (list_id, venue_id) DO NOTHING`,
        [user.favoritesListId, venueId, user.userId]
      );
    }

    if (index > 0 && index % 10 === 0) {
      process.stdout.write('.');
    }
  }
  if (userRecords.length > 10) process.stdout.write('\n');
}

function publicActionEvents() {
  return [
    { name: 'website_click', weight: 18 },
    { name: 'directions_click', weight: 22 },
    { name: 'call_click', weight: 8 },
    { name: 'share', weight: 7 },
    { name: 'promotion_view', weight: 12 },
    { name: 'promotion_click', weight: 6 },
  ];
}

function authenticatedActionEvents() {
  return [
    { name: 'save', weight: 16 },
    { name: 'follow', weight: 12 },
    { name: 'alert_subscribe', weight: 9 },
    { name: 'share', weight: 5 },
    { name: 'call_click', weight: 6 },
    { name: 'website_click', weight: 10 },
    { name: 'directions_click', weight: 14 },
  ];
}

function buildEventRow(input) {
  return [
    input.eventName,
    input.venueId,
    input.ownerUserId,
    input.promotionId ?? null,
    input.userId,
    input.visitorId,
    input.visitId,
    input.authenticated,
    input.source,
    input.deviceType,
    JSON.stringify(input.properties),
    input.occurredAt,
  ];
}

async function insertEventRows(client, rows) {
  const chunkSize = 250;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const values = [];
    const params = [];
    chunk.forEach((row, rowIndex) => {
      const base = rowIndex * 12;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}::jsonb, $${base + 12}::timestamptz)`
      );
      params.push(...row);
    });
    await client.query(
      `INSERT INTO merchant_analytics_events (
        event_name, venue_id, venue_owner_user_id, promotion_id, user_id,
        visitor_id, visit_id, authenticated, source, device_type, properties, occurred_at
      ) VALUES ${values.join(', ')}`,
      params
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(options.venueId) || options.venueId <= 0) {
    console.error('VENUE_ID / --venue must be a positive integer.');
    process.exit(1);
  }
  if (!Number.isInteger(options.days) || options.days < 1 || options.days > 366) {
    console.error('DAYS / --days must be between 1 and 366.');
    process.exit(1);
  }
  if (!Number.isInteger(options.visitors) || options.visitors < 1 || options.visitors > 5000) {
    console.error('VISITORS / --visitors must be between 1 and 5000.');
    process.exit(1);
  }
  if (!Number.isInteger(options.audienceSize) || options.audienceSize < 1 || options.audienceSize > 500) {
    console.error('AUDIENCE / --audience must be between 1 and 500.');
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Missing DATABASE_URL (or DATABASE_URL_UNPOOLED).');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: isLocalConnection(connectionString) ? false : { rejectUnauthorized: true },
  });
  await client.connect();

  try {
    const ownerResult = await client.query(
      `SELECT c.user_id, u.email
       FROM venue_claims c
       JOIN users u ON u.id = c.user_id
       WHERE c.venue_id = $1 AND c.status = 'verified'
       LIMIT 1`,
      [options.venueId]
    );
    const owner = ownerResult.rows[0];
    if (!owner) {
      console.error(`Venue ${options.venueId} has no verified owner claim. Claim the venue first.`);
      process.exit(1);
    }

    if (options.clear) {
      await clearSeededData(client, options.venueId);
      if (!process.argv.includes('--only-clear')) return;
    }

    const botUserCount = options.withAudience
      ? options.audienceSize
      : Math.max(12, Math.ceil(options.visitors * AUTHENTICATED_SHARE));
    console.log(`Ensuring ${botUserCount} bot users for venue ${options.venueId}...`);
    const botUsers = await ensureAnalyticsUsers(client, options.venueId, botUserCount);
    const botUserIds = botUsers.map((user) => user.userId);

    if (options.withAudience) {
      console.log(`Seeding audience relationships for ${botUsers.length} bot users...`);
      await seedAudience(client, options.venueId, botUsers);
    }

    const promotionRows = await client.query(
      `SELECT id FROM promotion_campaigns WHERE venue_id = $1 ORDER BY created_at DESC`,
      [options.venueId]
    );
    const promotionIds = promotionRows.rows.map((row) => row.id);

    const deviceTypes = ['mobile', 'desktop', 'tablet', 'unknown'];
    const rows = [];
    const visitorUsers = new Map();

    for (let visitorIndex = 0; visitorIndex < options.visitors; visitorIndex += 1) {
      const visitorId = crypto.randomUUID();
      const authenticated = Math.random() < AUTHENTICATED_SHARE;
      let userId = null;
      if (authenticated) {
        if (visitorUsers.has(visitorIndex)) {
          userId = visitorUsers.get(visitorIndex);
        } else {
          userId = randomItem(botUserIds);
          visitorUsers.set(visitorIndex, userId);
        }
      }
      const deviceType = randomItem(deviceTypes);
      const referrerHost = randomItem(REFERRERS);
      const visitsThisVisitor = randomInt(1, Math.random() < 0.18 ? 4 : 2);

      for (let visitIndex = 0; visitIndex < visitsThisVisitor; visitIndex += 1) {
        const visitId = crypto.randomUUID();
        const daysAgo = randomInt(0, options.days - 1);
        const hour = randomInt(11, 23);
        const occurredAt = dayOffsetMs(daysAgo, hour);

        rows.push(
          buildEventRow({
            eventName: 'venue_page_view',
            venueId: options.venueId,
            ownerUserId: owner.user_id,
            userId,
            visitorId,
            visitId,
            authenticated,
            source: 'venue_page',
            deviceType,
            properties: { seed: true, visitor_index: visitorIndex, referrer_host: referrerHost },
            occurredAt,
          })
        );

        const actionCount = randomInt(0, Math.random() < 0.35 ? 3 : 1);
        let followedThisVisit = false;
        for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
          const pool = authenticated ? authenticatedActionEvents() : publicActionEvents();
          let eventName = pickWeighted(pool.map((item) => ({ value: item.name, weight: item.weight })));

          if (!authenticated && ['save', 'follow', 'alert_subscribe'].includes(eventName)) {
            eventName = pickWeighted(publicActionEvents().map((item) => ({ value: item.name, weight: item.weight })));
          }
          if (eventName === 'alert_subscribe' && !followedThisVisit && Math.random() < 0.55) {
            rows.push(
              buildEventRow({
                eventName: 'follow',
                venueId: options.venueId,
                ownerUserId: owner.user_id,
                userId,
                visitorId,
                visitId,
                authenticated: true,
                source: 'venue_page',
                deviceType,
                properties: { seed: true, paired_with: 'alert_subscribe' },
                occurredAt: dayOffsetMs(daysAgo, hour, randomInt(1, 20)),
              })
            );
            followedThisVisit = true;
          }
          if (eventName === 'follow') followedThisVisit = true;

          const promotionId =
            ['promotion_view', 'promotion_click'].includes(eventName) && promotionIds.length
              ? randomItem(promotionIds)
              : null;

          rows.push(
            buildEventRow({
              eventName,
              venueId: options.venueId,
              ownerUserId: owner.user_id,
              promotionId,
              userId,
              visitorId,
              visitId,
              authenticated: ['save', 'follow', 'alert_subscribe'].includes(eventName) ? true : authenticated,
              source: 'venue_page',
              deviceType,
              properties: {
                seed: true,
                action_index: actionIndex,
                referrer_host: referrerHost,
                ...(eventName === 'alert_subscribe'
                  ? {
                      alert_type: Math.random() < 0.55 ? 'happy_hour' : 'live_deal',
                      channel: Math.random() < 0.85 ? 'email' : 'text',
                    }
                  : {}),
                ...(eventName === 'share'
                  ? { share_method: randomItem(['copy_link', 'native_share', 'text']) }
                  : {}),
              },
              occurredAt: dayOffsetMs(daysAgo, hour, randomInt(1, 45)),
            })
          );
        }
      }
    }

    await insertEventRows(client, rows);

    console.log(
      `Seeded ${rows.length} merchant analytics events for venue ${options.venueId} (${owner.email}) across the last ${options.days} days.`
    );
    if (options.withAudience) {
      console.log(`Seeded ${botUsers.length} audience users with saves, follows, and alert prefs.`);
      console.log('Open /restaurant/audience/?venueId=' + options.venueId);
    }
    console.log('Open /restaurant/reports/?venueId=' + options.venueId + ` (defaults to ${options.days}-day range).`);
    console.log('To remove seeded rows later: npm run seed:merchant-analytics -- --clear');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
