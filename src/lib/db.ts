import { Pool, type PoolClient } from 'pg';
import { getEnv } from './env';

// ---------------------------------------------------------------------------
// Postgres data layer (see README-NEON-MIGRATION.md for the full design
// rationale). Replaces src/lib/kv.ts's single-JSON-blob-per-table approach
// with real rows, real constraints, and real transactions.
//
// Driver choice — a deliberate deviation from the migration spec's literal
// suggestion of `@neondatabase/serverless`'s HTTP driver (`neon()`):
//
// That HTTP driver only speaks Neon's own hosted proxy protocol, which
// doesn't exist for the local Postgres this project develops against
// (README-NEON-MIGRATION.md §10 — a real Postgres 17, via Netlify's dev
// middleware + PGlite, speaking plain wire-protocol Postgres on
// localhost). Using the HTTP driver in production and something else
// locally would mean two different code paths for the same queries,
// undermining the exact thing §10 argues for: developing against real SQL
// with zero setup. Plain `pg` speaks standard wire-protocol Postgres, so it
// works identically against local PGlite and Neon's pooled connection
// string — one driver, one code path, actually testable end-to-end without
// a live Neon project. Neon's connection pooler (the "pooled" endpoint in
// `DATABASE_URL`) is explicitly built to absorb many short-lived
// connections from serverless functions, which is what the spec's
// "without connection-pool exhaustion" reasoning was really after.
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

export function isDbConfigured(): boolean {
  return Boolean(getEnv('DATABASE_URL'));
}

function isLocalConnection(connectionString: string): boolean {
  // Allow an optional `user[:pass]@` userinfo segment between `//` and the
  // host — connection strings almost always have one (e.g.
  // `postgres://postgres@127.0.0.1:5432/postgres`), and without this the
  // check silently fails, ssl gets requested against a local Postgres that
  // doesn't speak TLS, and every query errors with "the server does not
  // support SSL connections".
  return /\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
}

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = getEnv('DATABASE_URL');
  if (!connectionString) {
    throw new Error('Missing required environment variable DATABASE_URL. See README-NEON-MIGRATION.md.');
  }

  pool = new Pool({
    connectionString,
    // Local PGlite (via `netlify dev`, see README-NEON-MIGRATION.md §10)
    // doesn't speak TLS at all; Neon requires it. Detect by host rather
    // than requiring a second env var just to say "this is local."
    ssl: isLocalConnection(connectionString) ? false : { rejectUnauthorized: true },
    max: 5,
  });
  return pool;
}

export interface QueryExecutor {
  <T = any>(strings: TemplateStringsArray, ...values: any[]): Promise<T[]>;
}

function makeSqlTag(run: (text: string, params: any[]) => Promise<{ rows: any[] }>): QueryExecutor {
  return async function sql<T = any>(strings: TemplateStringsArray, ...values: any[]): Promise<T[]> {
    let text = strings[0];
    const params: any[] = [];
    for (let i = 0; i < values.length; i++) {
      params.push(values[i]);
      text += `$${params.length}${strings[i + 1]}`;
    }
    const result = await run(text, params);
    return result.rows as T[];
  };
}

// Tagged-template query helper: sql`SELECT * FROM users WHERE id = ${id}`.
// Interpolated values are always sent as bound parameters, never string-
// concatenated — this is the only way queries should be built anywhere in
// this data layer.
export const sql: QueryExecutor = makeSqlTag((text, params) => getPool().query(text, params));

// Runs `fn` inside a BEGIN/COMMIT block on a single dedicated connection,
// rolling back on any error. Use this for anything that needs more than
// one statement to succeed or fail together (e.g. the alert-cap check +
// insert in store.ts). The `sql` passed into `fn` is bound to the same
// client as the transaction — don't use the module-level `sql` export
// inside a transaction callback, it would run on a different connection
// entirely and defeat the point.
export async function withTransaction<T>(fn: (txSql: QueryExecutor) => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();
  const txSql = makeSqlTag((text, params) => client.query(text, params));
  try {
    await client.query('BEGIN');
    const result = await fn(txSql);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // Rolling back a connection that's already broken shouldn't mask
      // the original error.
    });
    throw err;
  } finally {
    client.release();
  }
}

// Distinguishes "the database is unreachable/misconfigured" from any other
// application error, so middleware.ts can surface a diagnosable message
// instead of the generic fallback (see README-NEON-MIGRATION.md §6 step 17).
export function isDbConnectionError(message: string): boolean {
  return (
    message.includes('DATABASE_URL') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND') ||
    message.includes('password authentication failed') ||
    message.includes('Connection terminated') ||
    message.includes('endpoint is disabled') // Neon's message when a project is suspended/misconfigured
  );
}
