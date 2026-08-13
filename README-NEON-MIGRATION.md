# Migrating the data layer from Upstash Redis to Neon Postgres

**Status:** done. **Drafted:** 2026-08-10. **Implemented:** 2026-08-12.

This was the implementation spec for replacing `src/lib/kv.ts` (Upstash
Redis, via `@vercel/kv`) with Neon Postgres. All four phases below are
built: `src/lib/db.ts` + `migrations/0001_init.sql` + `scripts/migrate.js`
(Phase 1), `src/lib/store.ts` + `src/lib/validation.ts` (Phase 2), every
call site across accounts/restaurants/admin/public/cron migrated (Phase 3),
and `kv.ts`/`@vercel/kv`/the `.data/` fallback removed with
`src/middleware.ts` updated (Phase 4). Schema verified against a local
PGlite-backed Postgres 17 (constraints, triggers, uniqueness, jsonb
queries, upserts — see §10). Kept for reference and for §7's future work
(moving venues into Postgres) — read this before touching the data layer.

**What's still open:** no real Neon project exists yet — `DATABASE_URL`/
`DATABASE_URL_UNPOOLED` need to be set (§6 step 2) before this runs against
anything but the local dev database. §9's decision 4 (SMS daily-cap
timezone) also remains unresolved, carried forward unchanged from the
pre-migration code rather than silently changed as part of this migration.

**PGlite doesn't survive real concurrent load — this was tested, and it's
the local emulator, not the schema.** Every `store.ts` accessor was
exercised individually against a local PGlite-backed Postgres and behaves
correctly (correct rows, correct constraint rejections, correct partial
updates). Run sequentially, 20/20 concurrent-style registrations succeed.
But firing them genuinely concurrently (`Promise.all`) against the same
local PGlite instance fails most of them with "Connection terminated
unexpectedly" — even 3 at once drops to roughly a 1-in-3 success rate. This
reproduces §10's own caveat ("whether PGlite's behavior is faithful enough
... is worth confirming early — if it diverges, fall back to a Neon dev
branch"): PGlite is a single-process embedded WASM Postgres, and the
third-party `pglite-socket` wrapper that exposes it over the wire protocol
locally doesn't reliably hold up several simultaneous physical connections,
regardless of `db.ts`'s connection pool. This is not evidence of a race in
the schema or in `store.ts` — the concurrency guarantees (unique indexes,
`ON CONFLICT` upserts, the alert-cap `WHERE count(*) < 25` insert) are
enforced by Postgres itself and work identically on real Postgres/Neon,
which handles concurrent connections natively. §8's concurrency checklist
items (20 simultaneous registrations, simultaneous saves across venues)
need to be re-run against a real Neon project or a real local `postgres`
(e.g. via Docker) before trusting them — not against the local PGlite dev
database.

---

## 1. Why migrate

The current store isn't really being used as a key-value store. Every
collection is **one Redis key holding one JSON array**:

```
sdhh:users   sdhh:submissions   sdhh:restaurants
sdhh:live-overrides   sdhh:promotions   sdhh:notification-log
```

`readUsers()` fetches the entire user table and `writeUsers()` overwrites it
(`kv.ts:176-184`). `savedSpots[]` and `alerts[]` are nested *inside* each user
object, so `sdhh:users` holds every user, every saved spot, and every alert in
the system. Three concrete consequences:

**A silent data-loss race.** Every mutation is read-modify-write with no
atomicity. `api/account/spots/[id].ts:13-64` reads all users, mutates one,
writes all users back. Two concurrent registrations both read the array, both
append, both write — one account is lost with no error. Same for a save
landing during a signup.

**Every operation costs O(all users).** One login downloads and re-uploads the
whole table. The worst offender is the cron: `netlify.toml` schedules
`dispatch-alerts` every 15 minutes (2,880 runs/month) and `notify.ts:71` reads
the full users blob each run. At ~1,000 users (~3 KB each, ~3 MB blob) that's
**~8.6 GB/month of bandwidth from the cron alone**, against Upstash's 10 GB
free allowance, with zero human visitors.

**A hard ceiling.** Upstash caps a request at 10 MB. Because the users blob is
written as a single value, writes stop working entirely once it exceeds that —
roughly 3,000–5,000 engaged users. That's a cliff, not a slope.

Postgres fixes all three structurally: real rows, real constraints, real
transactions, and indexed queries instead of full scans.

### Why Neon specifically

- Permanent free tier (0.5 GB storage, 100 CU-hours, 5 GB egress), no card.
- Scale-to-zero after 5 min idle rather than **pausing** (Supabase free pauses
  projects after a week of inactivity — bad for a low-traffic site).
- Netlify DB is Neon under the hood, and its managed flow requires you to
  connect a Neon account after 7 days anyway. Bringing your own Neon skips the
  middleman, stays free, and works on Netlify's free plan.
- `@neondatabase/serverless` speaks HTTP, so it works from Netlify Functions
  without connection-pool exhaustion.

### Do this instead of the Redis hash refactor

An earlier idea was to keep Redis and split `sdhh:users` into per-user hash
fields. Skip it. It solves the same problems this migration solves, in a place
we're planning to leave — that's building the data layer twice.

**Migrate while there is no production data.** Production writes have been
failing (no `KV_REST_API_*` configured, so `writeUsers()` falls through to
`writeLocal()` → read-only filesystem → `EROFS`), so the production store is
almost certainly empty. Migration cost is at its all-time low.

---

## 2. Scope

28 files import the data layer; 72 accessor calls total.

| Accessor | Calls | Accessor | Calls |
|---|---|---|---|
| `readUsers` | 17 | `writeSubmissions` | 4 |
| `readRestaurants` | 12 | `readSubmissions` | 4 |
| `writeUsers` | 11 | `readLiveOverrides` | 4 |
| `writeRestaurants` | 5 | `writePromotions` | 3 |
| `readPromotions` | 5 | `readNotificationLog` | 3 |
| | | `writeLiveOverrides` | 2 |
| | | `appendNotificationLog` | 2 |

Affected areas:

- **Accounts** (11 files) — `api/account/**`, `api/shared-lists/[shareId].ts`,
  `api/shared-alerts/[shareId]/[alertId].ts`
- **Restaurants** (8 files) — `api/restaurant/**`
- **Admin** (4 files) — `api/admin/restaurants/**`, `api/admin/submissions/**`
- **Public** (3 files) — `api/live-status.ts`, `api/promotions.ts`,
  `api/submissions.ts`
- **Cron** (1) — `netlify/functions/dispatch-alerts.mts` → `src/lib/notify.ts`
- **Sessions** — `src/lib/session.ts` (Redis TTL → `expires_at` column)

### Effort estimate

| Phase | Work | Estimate |
|---|---|---|
| 1 | `db.ts`, migration runner, `0001_init.sql` | 2–3 h |
| 2 | `store.ts` granular accessors (~25 functions) | 4–6 h |
| 3 | Migrate 72 call sites across 28 files | 6–10 h |
| 4 | Cleanup, drop fallback, update docs | 2–3 h |
| 5 | Verification pass | 3–4 h |
| | **Total** | **~20–25 h** |

### Explicitly out of scope

Venue data stays in `public/data/happy-hours.json`. It's git-committed content
imported directly at build time (`src/lib/venues.ts:1`), and approving a
submission commits to it via the GitHub API. Moving venues into Postgres is a
separate, larger project — see §7.

---

## 3. Design principles

These are the "extensible and robust" decisions, with reasoning, so future
changes don't have to re-litigate them.

1. **Normalize what you query; keep JSON for what evolves.** `saved_spots` and
   `alerts` become real tables (they're queried and mutated individually).
   `alerts.filters` and `submissions.listing` stay `jsonb` — both are shapes
   that change as features grow, and neither is filtered field-by-field in SQL.
   New filter dimensions then need no migration.

2. **`text` + `CHECK` instead of Postgres `ENUM`.** Enums require
   `ALTER TYPE` to extend and can't drop values. A `CHECK (status IN (...))`
   constraint is edited with one migration. Cheaper to evolve.

3. **`timestamptz`, never ISO strings.** Enables real ordering, indexing, and
   interval math — the 7-day notification prune becomes
   `WHERE sent_at < now() - interval '7 days'`.

4. **Case-insensitive email uniqueness via a functional index, not `citext`.**
   The code lowercases manually today (`api/account/google.ts:47`), which is
   easy to forget at a new call site. A `UNIQUE INDEX ON users (lower(email))`
   enforces it in the database instead. `citext` would be the more elegant
   choice, but it **is not available in the local dev database** (§10) — a
   functional index is portable across both and costs nothing.

5. **Let constraints replace application checks.** Registration's
   "does this email exist" read becomes a plain `INSERT` that catches unique
   violation `23505`. The database arbitrates, so the race disappears.

6. **DB-generated `uuid` primary keys.** Today ids are `user_${Date.now()}`
   (`api/account/google.ts:52`), which collides within a millisecond and leaks
   timing. `gen_random_uuid()` fixes both.

7. **No fake foreign keys.** Venue references are plain `integer` with
   `CHECK (venue_id > 0)` and no FK, because venues aren't in the database.
   Don't imply referential integrity that doesn't exist.

8. **Forward-only numbered migrations** with a `schema_migrations` table. No
   ad-hoc DDL against production.

9. **One shared `updated_at` trigger** rather than trusting 28 call sites.

10. **`metadata jsonb` escape hatch on `users` and `restaurants` only.** For
    genuinely experimental fields, so a spike doesn't need a migration.
    Promote anything that survives into a real column — don't let this become
    a junk drawer.

---

## 4. Schema

`migrations/0001_init.sql`. Table order matters (`sessions` references both
`users` and `restaurants`).

**No extensions required.** This is deliberate — see design principle 4 and
§10. `gen_random_uuid()` is core in Postgres 13+, so `pgcrypto` isn't needed,
and `citext` is avoided so the schema also runs on the local dev database.
Both facts were verified against Postgres 17.5.

```sql
CREATE TABLE schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### users

```sql
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL DEFAULT '',
  email                text NOT NULL,
  password_salt        text,
  password_hash        text,
  google_id            text,
  picture              text NOT NULL DEFAULT '',
  share_id             text NOT NULL UNIQUE,
  phone                text NOT NULL DEFAULT '',
  sms_consent_at       timestamptz,
  weekly_digest_opt_in boolean NOT NULL DEFAULT false,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without citext. Always write emails already
-- lowercased; this index is the backstop, and it also serves lookups by
-- `WHERE lower(email) = lower($1)`.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- Partial: many users have no Google identity, and NULLs aren't unique.
CREATE UNIQUE INDEX users_google_id_key ON users (google_id)
  WHERE google_id IS NOT NULL;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

> **Verify before adding:** a `CHECK (google_id IS NOT NULL OR password_hash
> IS NOT NULL)` constraint looks correct (every account arrives via Google or
> password) but confirm against `api/account/profile.ts` first — if that route
> can ever clear a password, the constraint will reject valid updates.

### restaurants

A second, separate login from consumer accounts — see
`README-NOTIFICATIONS-SETUP.md`.

```sql
CREATE TABLE restaurants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  email               text NOT NULL,
  password_salt       text,
  password_hash       text,
  website             text NOT NULL DEFAULT '',
  verified            boolean NOT NULL DEFAULT false,
  verification_method text CHECK (verification_method IN ('domain','manual')),
  verification_status text NOT NULL DEFAULT 'pending'
                        CHECK (verification_status IN ('verified','pending','denied')),
  claim_note          text NOT NULL DEFAULT '',
  denial_reason       text,
  plan                text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','paid')),
  sms_funding_enabled boolean NOT NULL DEFAULT false,
  venue_id            integer CHECK (venue_id IS NULL OR venue_id > 0),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX restaurants_email_lower_key ON restaurants (lower(email));
CREATE INDEX restaurants_venue_id_idx ON restaurants (venue_id)
  WHERE venue_id IS NOT NULL;
CREATE INDEX restaurants_verification_status_idx ON restaurants (verification_status);

CREATE TRIGGER restaurants_updated_at BEFORE UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

> `venue_id` is deliberately **not** unique. `kv.ts:219-222` records that venue
> claims are trusted rather than admin-arbitrated, which means two restaurants
> can currently claim the same venue. When that's tightened, add:
> `CREATE UNIQUE INDEX ON restaurants (venue_id) WHERE venue_id IS NOT NULL AND verification_status = 'verified';`

### sessions

Replaces Redis TTL (`session.ts:66` used `{ ex: MAX_AGE_SECONDS }`). The id is
the existing 32-byte hex token, so it stays `text`.

```sql
CREATE TABLE sessions (
  id            text PRIMARY KEY,
  role          text NOT NULL CHECK (role IN ('user','restaurant')),
  user_id       uuid REFERENCES users(id)       ON DELETE CASCADE,
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  CONSTRAINT sessions_subject CHECK (
    (role = 'user'       AND user_id IS NOT NULL AND restaurant_id IS NULL) OR
    (role = 'restaurant' AND restaurant_id IS NOT NULL AND user_id IS NULL)
  )
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
```

`ON DELETE CASCADE` means deleting an account logs it out for free. The
`sessions_subject` check makes the "exactly one subject per role" rule
structural rather than conventional.

### saved_spots

```sql
CREATE TABLE saved_spots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id   integer NOT NULL CHECK (venue_id > 0),
  status     text NOT NULL CHECK (status IN ('favorite','want-to-try','been-to')),
  note       text NOT NULL DEFAULT '',
  rating     smallint CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, venue_id)
);

CREATE INDEX saved_spots_user_id_idx ON saved_spots (user_id);

CREATE TRIGGER saved_spots_updated_at BEFORE UPDATE ON saved_spots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

`UNIQUE (user_id, venue_id)` encodes what `spots/[id].ts:54` does by hand
(one entry per venue per user) and turns the save into one `ON CONFLICT`
upsert. `rating` is left valid for any status; `kv.ts:70-74` says it's only
*meaningful* for `favorite`/`been-to`, which is a UI concern, not an invariant
worth a constraint.

### alerts

```sql
CREATE TABLE alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  filters         jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel_email   boolean NOT NULL DEFAULT true,
  channel_text    boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  source_alert_id uuid REFERENCES alerts(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alerts_user_id_idx ON alerts (user_id);
CREATE INDEX alerts_active_idx  ON alerts (active) WHERE active;
CREATE INDEX alerts_filters_gin ON alerts USING gin (filters);

CREATE TRIGGER alerts_updated_at BEFORE UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

`AlertChannels` is flattened to two booleans because both are queried by the
dispatch job; `AlertFilters` stays `jsonb` because it grows. `source_alert_id`
becomes a real self-referencing FK (`ON DELETE SET NULL` — provenance
shouldn't block deleting the original). The GIN index is speculative until
filters are queried in SQL; drop it if §7 never happens.

`MAX_ALERTS_PER_USER = 25` (`kv.ts:114`) is enforced in application code today,
which races. Enforce it inside the insert transaction:

```sql
INSERT INTO alerts (user_id, name, filters, channel_email, channel_text)
SELECT $1, $2, $3, $4, $5
WHERE (SELECT count(*) FROM alerts WHERE user_id = $1) < 25
RETURNING *;
```

Zero rows returned means the cap was hit.

### live_overrides and promotions

Both are keyed by venue, so `venue_id` is the natural primary key — no
surrogate id needed.

```sql
CREATE TABLE live_overrides (
  venue_id   integer PRIMARY KEY CHECK (venue_id > 0),
  active     boolean NOT NULL DEFAULT false,
  since      timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Only active, unexpired rows are ever read.
CREATE INDEX live_overrides_active_idx ON live_overrides (expires_at) WHERE active;

CREATE TABLE promotions (
  venue_id    integer PRIMARY KEY CHECK (venue_id > 0),
  deal_code   text NOT NULL,
  description text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

Add `set_updated_at` triggers to both.

### submissions

```sql
CREATE TABLE submissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','denied')),
  contact_name        text NOT NULL DEFAULT '',
  contact_email       text NOT NULL,
  contact_notes       text NOT NULL DEFAULT '',
  listing             jsonb NOT NULL,
  denial_reason       text,
  approved_listing_id integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX submissions_status_created_at_idx ON submissions (status, created_at DESC);

CREATE TRIGGER submissions_updated_at BEFORE UPDATE ON submissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

`listing` stays `jsonb` on purpose: it's a staging payload validated by
`validateListing()` (`kv.ts:431`) and then written into
`public/data/happy-hours.json`. Its shape must track that JSON file, so
pinning it to columns would mean a migration every time the venue format
changes. The `contact` object is flattened because it's small and stable.

### notification_log

```sql
CREATE TABLE notification_log (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  venue_id integer NOT NULL CHECK (venue_id > 0),
  channel  text NOT NULL CHECK (channel IN ('email','text')),
  sent_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_log_dedup_idx ON notification_log (user_id, venue_id, sent_at DESC);
CREATE INDEX notification_log_sent_at_idx ON notification_log (sent_at);   -- pruning
CREATE INDEX notification_log_sms_cap_idx ON notification_log (user_id, sent_at DESC)
  WHERE channel = 'text';
```

Retention (`kv.ts:342`, 7 days) moves from a rewrite-the-whole-array prune
into the cron:

```sql
DELETE FROM notification_log WHERE sent_at < now() - interval '7 days';
```

---

## 5. Query patterns that replace scans

The payoff. Each of these replaces a full-collection read plus a full write.

**Google sign-in** — replaces `readUsers` → `find` → mutate → `writeUsers`
(`api/account/google.ts:44-65`) with one atomic statement:

```sql
INSERT INTO users (name, email, google_id, picture, share_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (lower(email)) DO UPDATE SET
  google_id = EXCLUDED.google_id,
  name      = COALESCE(NULLIF(EXCLUDED.name, ''), users.name),
  picture   = EXCLUDED.picture
RETURNING *;
```

> The conflict target is the **expression** `lower(email)`, matching
> `users_email_lower_key`. `ON CONFLICT (email)` would fail — there's no plain
> unique constraint on the column. Pass `$2` already lowercased.

**Registration** — no pre-read; catch `23505` and return the existing
"An account already exists for that email." error:

```sql
INSERT INTO users (name, email, password_salt, password_hash, share_id)
VALUES ($1, $2, $3, $4, $5) RETURNING *;
```

**Save a spot** — replaces `spots/[id].ts:53-64`:

```sql
INSERT INTO saved_spots (user_id, venue_id, status, note, rating)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id, venue_id) DO UPDATE SET
  status = EXCLUDED.status, note = EXCLUDED.note, rating = EXCLUDED.rating
RETURNING *;
```

**Shared list by `shareId`** — `shared-lists/[shareId].ts:9-10` scans every
user; becomes an indexed lookup:

```sql
SELECT u.name, u.share_id, s.*
FROM users u LEFT JOIN saved_spots s ON s.user_id = u.id
WHERE u.share_id = $1;
```

**Alert dispatch** — the big one. `notify.ts:71,100-107` loads every user and
loops over all of them; instead fetch only alerts that could fire:

```sql
SELECT a.id, a.filters, a.channel_email, a.channel_text,
       u.id AS user_id, u.email, u.phone, u.sms_consent_at
FROM alerts a
JOIN users u ON u.id = a.user_id
WHERE a.active
  AND (a.channel_email OR (a.channel_text AND u.sms_consent_at IS NOT NULL));
```

> **Honest limitation:** matching an alert to a venue still happens in
> application code, because venues live in JSON, not the database
> (`alertMatchesVenue()` in `venues.ts:93`). The win is that the cron reads
> *active alerts* instead of *every user and all their data* — bandwidth stops
> scaling with total signups. Pushing matching into SQL requires §7.

**SMS daily cap** — currently derived by scanning the log in `notify.ts`:

```sql
SELECT count(*) FROM notification_log
WHERE user_id = $1 AND channel = 'text'
  AND sent_at >= date_trunc('day', now() AT TIME ZONE 'America/Los_Angeles');
```

> **Open question:** the current implementation's notion of "per day" should be
> checked against this. Pinning the boundary to San Diego local time is almost
> certainly what's intended for `SMS_DAILY_CAP_PER_USER`, but confirm the
> timezone handling rather than assuming UTC and local agree.

---

## 6. Implementation phases

Each phase is independently deployable and leaves the app working.

### Phase 1 — Foundation (no behavior change)

1. `npm i @neondatabase/serverless` (keep `@vercel/kv` for now).
2. Create a Neon project. Set in Netlify **and** local `.env`:
   ```
   DATABASE_URL=postgres://...      # pooled
   DATABASE_URL_UNPOOLED=postgres://...   # direct, for migrations
   ```
3. `src/lib/db.ts` — a `sql` tagged-template helper plus a `withTransaction()`
   wrapper. Read config through the existing `getEnv()` (`kv.ts:34`), **not**
   `import.meta.env` directly — `netlify/functions/dispatch-alerts.mts` is a
   standalone function where `import.meta.env` is never populated.
4. `migrations/0001_init.sql` + `scripts/migrate.js` (apply in filename order,
   record each in `schema_migrations`, wrap each file in a transaction).
5. Add `npm run migrate`. Run it against Neon. No app code reads Postgres yet.

**Ships:** nothing user-visible. Safe to deploy.

### Phase 2 — New accessor layer

6. `src/lib/store.ts` with granular accessors, replacing collection-wide
   read/write. Roughly:

   ```
   getUserById, getUserByEmail, getUserByGoogleId, getUserByShareId,
   createUser, updateUser, updateUserPreferences
   listSavedSpots, upsertSavedSpot, deleteSavedSpot
   listAlerts, getAlert, createAlert, updateAlert, deleteAlert
   createSession, getSession, deleteSession, deleteExpiredSessions
   getRestaurantById, getRestaurantByEmail, listRestaurants,
     createRestaurant, updateRestaurant
   listSubmissions, getSubmission, createSubmission, updateSubmission
   getLiveOverrides, setLiveOverride
   getPromotions, getPromotion, setPromotion, deletePromotion
   listRecentNotifications, appendNotifications, pruneNotifications
   ```

7. **Move the pure helpers out of the data layer.** `kv.ts:359-485` —
   `publicUser`, `publicRestaurant`, `hashPassword`, `verifyPassword`,
   `cleanString`, `cleanList`, `isValidTime`, `cleanAlertFilters`,
   `cleanAlertChannels`, `validateListing`, `validateSubmission`,
   `extractDomain` — have nothing to do with storage. Move them verbatim to
   `src/lib/validation.ts`.
8. Make `kv.ts` a thin re-export shim so all 28 existing imports keep
   resolving. Nothing breaks mid-migration.

**Ships:** dead code paths only. Safe to deploy.

### Phase 3 — Migrate call sites, one group at a time

Order chosen so the riskiest, highest-traffic paths go first while you're
paying closest attention, and the cron goes last:

9. **Sessions** (`session.ts`) — everything else depends on it.
10. **Accounts** (11 files) — login, register, google, me, profile,
    preferences, spots, alerts, shared-lists, shared-alerts.
11. **Restaurants** (8 files).
12. **Admin** (4 files).
13. **Public** (3 files) — `live-status`, `promotions`, `submissions`.
14. **Cron** (`notify.ts`) — switch to the alert query in §5 and move
    retention pruning into SQL.

Verify each group against §8 before starting the next.

### Phase 4 — Cleanup

15. Delete `kv.ts`; remove `@vercel/kv` from `package.json` (it's deprecated —
    `npm ci` warns about it) and drop `KV_REST_API_*` from Netlify and
    `.env.example`.
16. Remove the `.data/` fallback (`readLocal`/`writeLocal`) — see §9, decision 1.
17. **Update `src/middleware.ts:17`.** Its `isKvError` check tests for
    `'@vercel/kv'` / `'KV_REST_API'` in the message. After migration those
    strings never appear, so any database misconfiguration renders as the
    opaque `Something went wrong. Please try again.` — exactly the bug that
    made the original Google-login failure so hard to diagnose. Test for
    Postgres connection errors instead, and consider logging the real message
    server-side regardless.
18. Update `README-ACCOUNTS-SETUP.md` (its §1 "Connect a KV store" and the
    "Local development needs zero setup" section both become wrong) and
    `.env.example`.

---

## 7. Future: moving venues into Postgres

Not part of this migration; the natural next step once it's done.

Today venues are a git-committed JSON file imported at build time
(`venues.ts:1`), and approving a submission commits to it through the GitHub
API. That's genuinely reasonable for weekly schedules — the data is static,
versioned, reviewable in a PR, and free to serve. But it forces alert matching
into application code and means every venue edit is a deploy.

A `venues` table would let §5's dispatch query do matching in SQL (one indexed
query instead of a nested loop), make venue edits instant, and let the
`venue_id integer` columns in `saved_spots`, `restaurants`, `promotions`,
`live_overrides`, and `notification_log` become real foreign keys. The
migration path is deliberately open: those columns already hold the numeric
ids from `happy-hours.json`, so seeding a `venues` table with matching ids and
then adding FK constraints is additive.

The tradeoff is losing PR-reviewable venue data and static-site simplicity.
Worth doing when venue count or edit frequency makes the deploy loop painful —
not before.

---

## 8. Verification checklist

Run per phase group, not just at the end. `npm test` only runs
`validate:data`, so this is manual.

**Accounts**
- [ ] Register with email/password; confirm the row and a session cookie.
- [ ] Register the *same* email again → "An account already exists for that email."
- [ ] Log in with wrong password → "Invalid email or password."
- [ ] Google sign-in on a fresh email → creates a user.
- [ ] Google sign-in on an email that already registered with a password →
      links `google_id` to the existing row, does **not** duplicate.
- [ ] Save a spot, change its status, add a note and rating, unsave it.
- [ ] Save the same venue twice → one row, updated (not two).
- [ ] Create alerts up to the 25 cap → the 26th is refused.
- [ ] Clone a shared alert → `source_alert_id` set.
- [ ] Open `/api/shared-lists/<shareId>` and a shared alert link while signed out.
- [ ] Update profile and preferences (phone, SMS consent, weekly digest).
- [ ] Log out → session row gone, cookie cleared.

**Restaurants / admin**
- [ ] Register, claim a venue, domain auto-verification via `extractDomain`.
- [ ] Admin approve → commits to `happy-hours.json`; deny → records reason.
- [ ] Toggle live; confirm it expires rather than sticking on.
- [ ] Set and clear a promotion; confirm `dealCode` is only returned to a
      signed-in user (`api/promotions.ts`).

**Cron**
- [ ] Trigger `dispatch-alerts` manually via `api/admin/dispatch-alerts.ts`.
- [ ] Dedup: run twice; no duplicate notification for the same user+venue.
- [ ] SMS cap respected across a day boundary.
- [ ] Prune deletes rows older than 7 days and nothing newer.

**Concurrency (the whole point)**
- [ ] Fire ~20 simultaneous registrations with distinct emails; confirm all 20
      exist. Under the old blob store most would vanish.
- [ ] Fire simultaneous saves for one user across different venues; confirm
      none are lost.

**Operational**
- [ ] Cold start after >5 min idle still serves a page (scale-to-zero wake).
- [ ] Deliberately break `DATABASE_URL` and confirm the error surfaced is
      diagnosable, not the generic middleware message (Phase 4, step 17).

---

## 9. Decisions needed before starting

1. **Drop the `.data/` local fallback?** *Recommend: yes* — and §10 makes this
   much cheaper than it first looked. Maintaining a second full implementation
   of ~25 granular accessors against JSON files is how data layers rot. The
   local dev database that already runs during `astro dev` can take its place,
   so the "local development needs zero setup" property that
   `README-ACCOUNTS-SETUP.md:12-16` advertises is preserved rather than traded
   away. A free Neon dev branch is the fallback if that proves unreliable.
2. **Keep venues in JSON?** *Recommend: yes for now* — see §7.
3. **`uuid` keys, or preserve existing `user_...` string ids?** *Recommend:
   uuid*, since there's no production data to preserve. If any local `.data/`
   content matters, the import script needs an old-id → new-id map.
4. **SMS daily-cap timezone** — confirm America/Los_Angeles vs UTC (§5).
5. **Sessions in Postgres, or keep Upstash just for sessions?** *Recommend:
   Postgres.* Redis is genuinely better at TTL sessions, but running two
   services for one table isn't worth it at this size. Revisit if session
   lookups ever show up in latency traces.

---

## 10. The local dev database that already exists

Investigated 2026-08-10. **There is no cloud database provisioned for this
site** — but a local Postgres is already running during development, and it
changes the local-dev story.

### What it is

`astro dev` loads Netlify's dev middleware, which reports
`Emulating features: aiGateway, blobs, database, ...`. That `database` feature
starts a real Postgres via `@netlify/database-dev` (0.10.1) backed by
`@electric-sql/pglite` (0.3.16) — Postgres compiled to WebAssembly, running
in-process. Verified by querying it:

```
PostgreSQL 17.5 on aarch64-unknown-linux-gnu, compiled by emcc ... 32-bit
```

`.netlify/state.json` holds its connection string
(`postgres://localhost:<ephemeral-port>/postgres`), and `.netlify/db/` is its
20 MB data directory. Both are gitignored.

### It is *not* evidence of a provisioned Netlify DB

`.netlify/state.json` contains **no `siteId`** — the site still isn't linked.
The only table present is `netlify.migrations` (Netlify's own bookkeeping);
there are no application tables. This is purely local emulation, created
automatically by running the dev server. Provisioning real Neon/Netlify DB
(Phase 1, step 2) is still required.

### Why it matters

It's a genuine, zero-setup Postgres 17 for local development — which is what
makes dropping the `.data/` JSON fallback (§9, decision 1) cheap rather than a
regression. Run migrations against the string in `state.json` and develop
against real SQL with no signup.

### Two verified constraints

1. **`citext` and `pgcrypto` are not available.** `CREATE EXTENSION citext`
   fails with `extension "citext" is not available`. Real Neon supports both,
   but relying on them would mean the schema runs in production and fails
   locally. This is why §4 needs no extensions and emails use a
   `lower(email)` unique index.
2. **`gen_random_uuid()` works without `pgcrypto`** — it's core in Postgres
   13+. Confirmed returning a valid uuid on this instance.

> Treat this database as disposable. The port is ephemeral (it changes between
> dev-server runs, so read it from `state.json` rather than hardcoding), and
> the data directory can be deleted at any time. Anything that must survive
> belongs in a migration file, never in ad-hoc local DDL. Whether PGlite's
> behavior is faithful enough to Neon for the full test suite is worth
> confirming early in Phase 1 — if it diverges, fall back to a Neon dev branch.

---

## 11. Rollback

Phases 1–2 add code without changing behavior; reverting is a normal deploy.

During Phase 3 each group is one commit, so `git revert` plus a redeploy
restores the Redis path — as long as `@vercel/kv`, the `KV_REST_API_*` env
vars, and `kv.ts` all still exist. **Don't start Phase 4 until Phase 3 has run
in production long enough to trust**, because step 15 removes the rollback
target.

Any data written to Postgres after a group ships won't exist in Redis if you
roll back. Given the store is empty today, the practical window where this
matters is small — but export `users` and `saved_spots` before Phase 4 anyway.
