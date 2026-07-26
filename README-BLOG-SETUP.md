# Blog + CMS + AI Draft Generator — Setup Guide

This branch (`feature/astro-blog-cms`) converts the site to Astro and adds:

- A real, indexable page per venue at `/venues/<slug>/` (previously venues only existed as JS-rendered cards).
- A blog at `/blog/` (Markdown posts in `src/content/blog/`), each with its own real, SEO-friendly page.
- Sveltia CMS at `/admin/` — a free, browser-based editor that commits Markdown files straight to this GitHub repo. No database, no separate backend.
- An "AI draft generator" at `/admin/generate.html` — paste your idea/angle and any source material, Claude drafts the post, it lands as a draft entry in the same CMS for you to review, edit, and publish.

Nothing here costs money except the Claude API calls (pennies per post) and, optionally, Vercel/Cloudflare if you outgrow their free tiers.

## Part 1 — One-time setup (you'll need to do this yourself; it needs your GitHub/Vercel/Anthropic accounts)

### 1. Push this branch and deploy to Vercel
- Push `feature/astro-blog-cms` to GitHub, then connect the repo in Vercel (if not already). Vercel auto-detects Astro.
- Merge to `main` once you've reviewed it, or deploy the branch as a preview first — up to you.

### 2. Get an Anthropic API key
- console.anthropic.com → API Keys → create one. This is what `ANTHROPIC_API_KEY` uses.

### 3. Create a GitHub Personal Access Token (for the AI generator to commit drafts)
- GitHub → Settings → Developer settings → Personal access tokens → Fine-grained token.
- Scope it to just this repo, with **Contents: Read and write** permission.
- This becomes the `GITHUB_TOKEN` env var. (Different from the OAuth app below — this one is for the server, not for humans logging into the CMS.)

### 4. Pick a shared secret for the draft generator
- Make up any random string, e.g. `openssl rand -hex 16`. This becomes `DRAFT_API_TOKEN` — it's the "Admin token" field on the `/admin/generate.html` page, just there to stop randoms from hitting your API and spending your Claude credits.

### 5. Set environment variables in Vercel
Project Settings → Environment Variables:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | from step 2 |
| `ANTHROPIC_MODEL` | optional, defaults to `claude-sonnet-5` |
| `GITHUB_TOKEN` | from step 3 |
| `GITHUB_OWNER` | your GitHub username/org |
| `GITHUB_REPO` | `sd-happy-hour` (or whatever you named it) |
| `GITHUB_BRANCH` | `main` |
| `DRAFT_API_TOKEN` | from step 4 |

Redeploy after adding these.

### 6. Set up Sveltia CMS login (so you can use `/admin/` itself)
Sveltia CMS needs a small OAuth relay to let you log in with GitHub. The maintainers publish a ready-made one:

1. Fork/deploy **sveltia/sveltia-cms-auth** (github.com/sveltia/sveltia-cms-auth) — it's a tiny Cloudflare Worker, free tier is plenty.
2. Create a GitHub OAuth App (GitHub → Settings → Developer settings → OAuth Apps → New OAuth App). Set its callback URL per the worker's README.
3. Add the OAuth App's Client ID/Secret as environment variables on the Cloudflare Worker (via the Cloudflare dashboard).
4. Note the Worker's URL (`https://sveltia-cms-auth.<you>.workers.dev`).

Then edit `public/admin/config.yml` in this repo:
```yaml
backend:
  name: github
  repo: YOUR_GITHUB_USERNAME/sd-happy-hour
  branch: main
  base_url: https://sveltia-cms-auth.<you>.workers.dev
```
Commit and redeploy. Visit `/admin/` and log in with GitHub.

This step is the fiddliest part of the whole setup and the one most worth doing together over a screen-share the first time — everything else is copy-pasting keys into a form.

## Part 2 — Day-to-day usage

**Writing a normal post by hand:** go to `/admin/`, log in, "New Blog Posts" entry, fill it in, uncheck "Draft" when ready, publish. That's a commit to the repo; Vercel rebuilds automatically.

**Generating an AI draft:** go to `/admin/generate.html`. Paste your idea/angle (required) and any source material — a Google Alert result, a scraped article, your own notes (optional). If the post is about specific venues, add their slugs (the part of the URL after `/venues/`) so Claude gets real, verified hours/deals instead of guessing. Hit Generate. It'll show a link straight into the CMS editor for that new draft.

**Reviewing:** the draft always lands with `draft: true`, so it's never publicly visible until someone reviews it. Open it in `/admin/`, read it like you would any junior writer's draft — the one thing worth actually checking is that any specific venue facts match reality — edit anything off, uncheck Draft, publish.

**Cost per post:** roughly a few cents of Claude API usage. No other per-post cost.

## What's still a manual/human step, on purpose

- Nobody's post goes live without a human unchecking "Draft" — there's no auto-publish path, by design (see the earlier automation plan for why: unsupervised AI content about real, specific local businesses is the one place small factual errors do real damage to trust).
- The generator only knows verified facts about venues you explicitly tag by slug. Anything else it writes about a specific business should be treated as unverified until you check it.
