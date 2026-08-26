#!/usr/bin/env node
// Insert realistic merchant analytics events for local report UI testing.
//
// Usage:
//   npm run seed:merchant-analytics
//   VENUE_ID=21 DAYS=30 VISITORS=120 npm run seed:merchant-analytics
//   npm run seed:merchant-analytics -- --clear
//
// Events are tagged with properties.seed = true so --clear removes only seeded rows.

import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

function parseArgs(argv) {
  const options = {
    venueId: Number(process.env.VENUE_ID || 21),
    days: Number(process.env.DAYS || 30),
    visitors: Number(process.env.VISITORS || 120),
    clear: false,
  };
  for (const arg of argv) {
    if (arg === '--clear') options.clear = true;
    else if (arg.startsWith('--venue=')) options.venueId = Number(arg.slice(8));
    else if (arg.startsWith('--days=')) options.days = Number(arg.slice(7));
    else if (arg.startsWith('--visitors=')) options.visitors = Number(arg.slice(11));
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
      const deleted = await client.query(
        `DELETE FROM merchant_analytics_events
         WHERE venue_id = $1 AND COALESCE(properties->>'seed', 'false') = 'true'`,
        [options.venueId]
      );
      console.log(`Removed ${deleted.rowCount} seeded events for venue ${options.venueId}.`);
      if (!process.argv.includes('--only-clear')) return;
    }

    const deviceTypes = ['mobile', 'desktop', 'tablet', 'unknown'];
    const actionEvents = [
      { name: 'website_click', weight: 18 },
      { name: 'directions_click', weight: 22 },
      { name: 'call_click', weight: 8 },
      { name: 'save', weight: 14 },
      { name: 'share', weight: 5 },
      { name: 'follow', weight: 10 },
      { name: 'promotion_view', weight: 12 },
      { name: 'promotion_click', weight: 6 },
    ];

    const rows = [];
    for (let visitorIndex = 0; visitorIndex < options.visitors; visitorIndex += 1) {
      const visitorId = crypto.randomUUID();
      const authenticated = Math.random() < 0.28;
      const userId = authenticated ? owner.user_id : null;
      const deviceType = randomItem(deviceTypes);
      const visitsThisVisitor = randomInt(1, Math.random() < 0.18 ? 4 : 2);

      for (let visitIndex = 0; visitIndex < visitsThisVisitor; visitIndex += 1) {
        const visitId = crypto.randomUUID();
        const daysAgo = randomInt(0, options.days - 1);
        const hour = randomInt(11, 23);
        const occurredAt = dayOffsetMs(daysAgo, hour);

        rows.push([
          'venue_page_view',
          options.venueId,
          owner.user_id,
          null,
          userId,
          visitorId,
          visitId,
          authenticated,
          'venue_page',
          deviceType,
          JSON.stringify({ seed: true, visitor_index: visitorIndex }),
          occurredAt,
        ]);

        const actionCount = randomInt(0, Math.random() < 0.35 ? 3 : 1);
        for (let actionIndex = 0; actionIndex < actionCount; actionIndex += 1) {
          const eventName = pickWeighted(actionEvents.map((item) => ({ value: item.name, weight: item.weight })));
          rows.push([
            eventName,
            options.venueId,
            owner.user_id,
            null,
            userId,
            visitorId,
            visitId,
            authenticated,
            'venue_page',
            deviceType,
            JSON.stringify({ seed: true, action_index: actionIndex }),
            dayOffsetMs(daysAgo, hour, randomInt(1, 45)),
          ]);
        }
      }
    }

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

    console.log(
      `Seeded ${rows.length} merchant analytics events for venue ${options.venueId} (${owner.email}) across the last ${options.days} days.`
    );
    console.log('Open /restaurant/reports/?venueId=' + options.venueId + ' and choose the 30-day range.');
    console.log('To remove seeded rows later: npm run seed:merchant-analytics -- --clear');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
