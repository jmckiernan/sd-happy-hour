#!/usr/bin/env node
// Forward-only migration runner (README-NEON-MIGRATION.md §3 decision 8 / §6
// step 4). Applies migrations/*.sql in filename order, each in its own
// transaction, recording each success in `schema_migrations` so reruns are
// no-ops. No down-migrations — fix forward with a new numbered file.
//
// Usage: npm run migrate
// (invoked as `node --env-file-if-exists=.env scripts/migrate.js` — see
// package.json — so DATABASE_URL_UNPOOLED/DATABASE_URL come from a local
// .env when present, or straight from the real environment on Netlify/CI.)

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function isLocalConnection(connectionString) {
  // Allow an optional `user[:pass]@` userinfo segment between `//` and the
  // host (see the matching comment in src/lib/db.ts) — without it this
  // check silently fails for ordinary connection strings like
  // `postgres://postgres@127.0.0.1:5432/postgres` and ssl gets requested
  // against a local Postgres that doesn't speak TLS.
  return /\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
}

async function main() {
  // Prefer the direct (unpooled) connection for DDL — migrations run rarely
  // and some DDL doesn't play well through a transaction-mode pooler.
  // Local dev has only one connection string (see README-NEON-MIGRATION.md
  // §10), so falling back to DATABASE_URL is normal there, not a warning
  // sign.
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Missing DATABASE_URL (or DATABASE_URL_UNPOOLED). See README-NEON-MIGRATION.md.');
    process.exit(1);
  }

  const client = new Client({
    connectionString,
    ssl: isLocalConnection(connectionString) ? false : { rejectUnauthorized: true },
  });
  await client.connect();

  try {
    // Bootstrap-safe: schema_migrations is itself created by 0001_init.sql,
    // so on a brand-new database this returns null and every migration file
    // (including 0001) runs. On a database that's been migrated before, this
    // finds the real table and the loop below skips whatever's already
    // recorded in it.
    const { rows: existsRows } = await client.query(`SELECT to_regclass('public.schema_migrations') AS reg`);
    const bookkeepingExists = Boolean(existsRows[0]?.reg);

    const applied = new Set();
    if (bookkeepingExists) {
      const { rows } = await client.query('SELECT version FROM schema_migrations');
      for (const row of rows) applied.add(row.version);
    }

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    if (!files.length) {
      console.log('No migration files found in migrations/.');
      return;
    }

    let ranAny = false;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }

      const sqlText = await readFile(path.join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`apply ${file}...`);
      try {
        await client.query('BEGIN');
        await client.query(sqlText);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`  ok`);
        ranAny = true;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`  FAILED: ${err.message}`);
        throw err;
      }
    }

    if (!ranAny) console.log('Already up to date.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
