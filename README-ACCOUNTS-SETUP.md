# Accounts, Saved Lists & Submissions — Setup Guide

This restores a feature that existed on `main` (commit "Add backend submissions and saved lists") before this branch converted the site to Astro. It's been reimplemented to fit the new setup — Netlify Functions instead of a self-hosted Node server — but the behavior is the same:

- **Google Sign-In** at `/account/` (with an email/password fallback if Google isn't configured yet).
- **Saved lists** — click the bookmark icon on any homepage card or venue page to save it as a favorite / want-to-try / been-to, with an optional note. Share a read-only link to your list from `/account/`.
- **Submit a Spot** at `/submit/` — a public form for restaurants/patrons to suggest a happy hour. Submissions land in a review queue.
- **Admin review** at `/admin/` (sign in at `/account/` with an admin email — see below) — approve, edit, or deny submissions. Approving one commits it straight into `public/data/happy-hours.json` via the GitHub API, the same way the AI blog draft generator publishes posts — it becomes a real venue page on the next deploy.

Nothing here costs money beyond a free-tier Neon Postgres database (permanent free tier, no card — see `README-NEON-MIGRATION.md` for why Neon).

## Local development needs zero setup

`npm run dev` works out of the box — `astro dev` runs a real local Postgres automatically (via Netlify's dev middleware, backed by PGlite; see `README-NEON-MIGRATION.md` §10), so accounts, saved lists, and submissions are stored in real SQL with no signup. Just add `GOOGLE_CLIENT_ID` to `.env` if you want to test Google Sign-In (see below); everything else works immediately, including the email/password fallback. Run `npm run migrate` once to create the schema against that local database.

## One-time setup for deploying

### 1. Connect Neon Postgres
User accounts, saved lists, alerts, restaurant accounts, live overrides, promotions, submissions, and the notification log all live in Postgres, which needs to be a real, durable database once this runs as Netlify Functions (which can't write to local files or keep things in memory between requests).

Create a free project at [neon.tech](https://neon.tech), then set `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct, for migrations) in Netlify's Environment Variables (Site configuration → Environment variables). Run `npm run migrate` once against the new database (`DATABASE_URL_UNPOOLED` set locally, or via `netlify env:pull` — see below) to create the schema. See `README-NEON-MIGRATION.md` for the full design.

If you want to test against the real Neon database locally too (instead of the local PGlite database `astro dev` starts automatically), pull those values from Netlify with:
```
netlify link
netlify env:pull .env.development.local
```

### 2. Set up Google Sign-In (optional, but recommended)
1. console.cloud.google.com → create a project (or reuse one) → **APIs & Services** → **Credentials**.
2. **Create Credentials** → **OAuth client ID** → Application type **Web application**.
3. Add your site's origin (e.g. `https://sdhappyhours.com`) under **Authorized JavaScript origins**. You don't need a redirect URI — this uses Google Identity Services' one-tap/button flow, not a redirect.
4. Copy the **Client ID** → set it as `GOOGLE_CLIENT_ID` in Netlify's Environment Variables.

Until this is set, `/account/` automatically falls back to a plain email/password form, so accounts and saved lists still work end-to-end for local testing.

### 3. Admin access
There's no separate admin login. Whoever signs in at `/account/` (Google or email/password) with an email listed in `ADMIN_EMAILS` (`src/lib/admins.ts`) automatically gets full admin rights — reviewing/approving/denying submissions at `/admin/`, and generating blog posts at `/admin/new-post/`. Edit that file directly to add or remove admins.

### 4. Confirm the GitHub commit vars are set
Admin approvals reuse the same `GITHUB_TOKEN` / `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` variables the blog's AI draft generator uses (see `README-BLOG-SETUP.md`). If you already set those up, approvals will just work. The token needs **Contents: Read and write** on this repo.

### 5. Image storage (no setup needed on Netlify)
Featured images uploaded or downloaded through the blog draft editor (see `README-BLOG-SETUP.md`) are stored using Netlify Blobs — object storage that's built into every Netlify site automatically, with no separate account, API key, or env var to configure. It only works once actually deployed on Netlify (or running locally via `netlify dev` instead of plain `astro dev`); under plain `npm run dev` it falls back to writing files under `.data/images/` (unrelated to the accounts/submissions database above — this is only for images).

Redeploy after adding/changing any of the above.

## Day-to-day usage

**Saving spots:** click the bookmark icon on a card (homepage) or the Save button (venue page). If you're not signed in, it sends you to `/account/` first.

**Sharing a list:** on `/account/`, "Copy share link" — anyone with that link can view your saved spots at `/list/?id=...`, no login required.

**Reviewing submissions:** `/admin/` (sign in at `/account/` with an admin email). Each submission shows the raw listing JSON, editable inline. Approve commits it to the repo (goes live on next deploy); Deny asks for a reason and archives it; Save Edit updates the listing without changing its status.

Note that approving a submission while running only against the local PGlite database (no Neon connected) still commits the new venue to GitHub via `GITHUB_TOKEN` — that part always talks to the real repo, regardless of where the submissions queue itself is stored.
