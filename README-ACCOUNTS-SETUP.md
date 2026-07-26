# Accounts, Saved Lists & Submissions — Setup Guide

This restores a feature that existed on `main` (commit "Add backend submissions and saved lists") before this branch converted the site to Astro. It's been reimplemented to fit the new setup — Vercel serverless functions instead of a self-hosted Node server — but the behavior is the same:

- **Google Sign-In** at `/account/` (with an email/password fallback if Google isn't configured yet).
- **Saved lists** — click the bookmark icon on any homepage card or venue page to save it as a favorite / want-to-try / been-to, with an optional note. Share a read-only link to your list from `/account/`.
- **Submit a Spot** at `/submit/` — a public form for restaurants/patrons to suggest a happy hour. Submissions land in a review queue.
- **Admin review** at `/admin/` (behind `/login/`) — approve, edit, or deny submissions. Approving one commits it straight into `public/data/happy-hours.json` via the GitHub API, the same way the AI blog draft generator publishes posts — it becomes a real venue page on the next deploy.

Nothing here costs money beyond Vercel's free tier for KV (or an Upstash free tier, same thing under the hood).

## Local development needs zero setup

`npm run dev` works out of the box — accounts, saved lists, and submissions are stored in a local `.data/` folder (gitignored) when no KV store is configured, the same way the original prototype used local JSON files with `node server.js`. Just add `GOOGLE_CLIENT_ID` to `.env` if you want to test Google Sign-In (see below); everything else works immediately, including the email/password fallback.

That local `.data/` folder only works because `astro dev` is a normal, persistent local process with real filesystem access. It won't work once deployed — Vercel's serverless functions have an ephemeral, mostly read-only filesystem — which is why production needs an actual store, below.

## One-time setup for deploying

### 1. Connect a KV store
User accounts, saved lists, and the submission queue need somewhere durable to live once this runs as Vercel serverless functions, which can't write to local files or keep things in memory between requests.

Vercel KV itself is retired — existing KV stores were auto-migrated to Upstash Redis, and new projects add it from the Marketplace instead: your project → **Storage** → **Marketplace Database Providers** → **Upstash** → **Redis** (the underlying product is still called "Upstash for Redis," previously "KV"). Connect it to this project and Vercel injects `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, and `KV_REST_API_READ_ONLY_TOKEN` automatically — the `@vercel/kv` package this code uses reads those same variable names either way, no code changes needed. As soon as those two vars (`KV_REST_API_URL`/`KV_REST_API_TOKEN`) are present, the code automatically switches from the local `.data/` fallback to real KV — nothing else to flip.

If you want to test against the real store locally too (instead of the `.data/` fallback), pull those down with:
```
vercel link
vercel env pull .env.development.local
```

### 2. Set up Google Sign-In (optional, but recommended)
1. console.cloud.google.com → create a project (or reuse one) → **APIs & Services** → **Credentials**.
2. **Create Credentials** → **OAuth client ID** → Application type **Web application**.
3. Add your site's origin (e.g. `https://sdhappyhours.com`) under **Authorized JavaScript origins**. You don't need a redirect URI — this uses Google Identity Services' one-tap/button flow, not a redirect.
4. Copy the **Client ID** → set it as `GOOGLE_CLIENT_ID` in Vercel's Environment Variables.

Until this is set, `/account/` automatically falls back to a plain email/password form, so accounts and saved lists still work end-to-end for local testing.

### 3. Set admin credentials
Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in Vercel's Environment Variables — these gate `/admin/`. The code defaults to `admin` / `password` if unset, which is fine for local dev but should be changed before anyone else can reach your deployment.

### 4. Confirm the GitHub commit vars are set
Admin approvals reuse the same `GITHUB_TOKEN` / `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` variables the blog's AI draft generator uses (see `README-BLOG-SETUP.md`). If you already set those up, approvals will just work. The token needs **Contents: Read and write** on this repo.

Redeploy after adding/changing any of the above.

## Day-to-day usage

**Saving spots:** click the bookmark icon on a card (homepage) or the Save button (venue page). If you're not signed in, it sends you to `/account/` first.

**Sharing a list:** on `/account/`, "Copy share link" — anyone with that link can view your saved spots at `/list/?id=...`, no login required.

**Reviewing submissions:** `/admin/` (log in at `/login/`). Each submission shows the raw listing JSON, editable inline. Approve commits it to the repo (goes live on next deploy); Deny asks for a reason and archives it; Save Edit updates the listing without changing its status.

Note that approving a submission while running only against the local `.data/` fallback (no KV connected) still commits the new venue to GitHub via `GITHUB_TOKEN` — that part always talks to the real repo, regardless of where the submissions queue itself is stored.
