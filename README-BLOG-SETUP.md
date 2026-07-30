# Blog + AI Draft Generator — Setup Guide

This branch (`feature/astro-blog-cms`) converts the site to Astro and adds:

- A real, indexable page per venue at `/venues/<slug>/` (previously venues only existed as JS-rendered cards).
- A blog at `/blog/` (Markdown posts in `src/content/blog/`), each with its own real, SEO-friendly page.
- An "Add Blog Post" generator at `/admin/new-post/` — paste your idea/angle and any source material, Claude drafts the post and commits it to the repo as a draft. Only visible in the nav, and only usable, when signed in with an authorized email (see below).

There's no separate CMS or GitHub OAuth to set up — writing a post by hand just means adding a `.md` file to `src/content/blog/` (by hand, or via GitHub's own web editor), same as any other file in the repo.

Nothing here costs money except the Claude API calls (pennies per post).

## Who can generate posts

There's no separate admin login for this (or for the submissions review queue at `/admin/`). Both are gated by the same check: sign in at `/account/` (Google or email/password) with an email listed in `ADMIN_EMAILS`, in `src/lib/admins.ts`:

```ts
export const ADMIN_EMAILS = ['jmckiernan86@gmail.com', 'shanewlykins@gmail.com'];
```

Add or remove emails there directly if the list ever needs to change — whoever's on it gets full admin rights everywhere (submissions + blog posts), automatically.

## One-time setup (you'll need to do this yourself; it needs your GitHub/Vercel/Anthropic accounts)

### 1. Push this branch and deploy to Vercel
- Push `feature/astro-blog-cms` to GitHub, then connect the repo in Vercel (if not already). Vercel auto-detects Astro.
- Merge to `main` once you've reviewed it, or deploy the branch as a preview first — up to you.

### 2. Get an Anthropic API key
- console.anthropic.com → API Keys → create one. This is what `ANTHROPIC_API_KEY` uses.

### 3. Create a GitHub Personal Access Token (for the AI generator to commit drafts)
- GitHub → Settings → Developer settings → Personal access tokens → Fine-grained token.
- Scope it to just this repo, with **Contents: Read and write** permission.
- This becomes the `GITHUB_TOKEN` env var — the same one already used for committing approved venue submissions (see README-ACCOUNTS-SETUP.md).

### 4. Set environment variables in Vercel
Project Settings → Environment Variables:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | from step 2 |
| `ANTHROPIC_MODEL` | optional, defaults to `claude-sonnet-5` |
| `GITHUB_TOKEN` | from step 3 |
| `GITHUB_OWNER` | your GitHub username/org |
| `GITHUB_REPO` | `sd-happy-hour` (or whatever you named it) |
| `GITHUB_BRANCH` | `main` |

Redeploy after adding these.

## Day-to-day usage

**Writing a normal post by hand:** add a `.md` file to `src/content/blog/` with the right frontmatter (see any existing post for the shape) — either locally and push, or directly in GitHub's web editor.

**Generating an AI draft:** sign in at `/account/` with an authorized email, then the "Add Blog Post" nav link appears — go to `/admin/new-post/`. Paste your idea/angle (required) and any source material — a Google Alert result, a scraped article, your own notes (optional). If the post is about specific venues, add their slugs (the part of the URL after `/venues/`) so Claude gets real, verified hours/deals instead of guessing. Hit Generate — it commits the draft to the repo as a file.

**Reviewing and publishing — no GitHub needed:** the draft always lands with `draft: true`, so it's never publicly visible until someone reviews it. After generating, click through to `/admin/drafts/<slug>/` (or go to `/admin/drafts/` any time to see everything waiting for review) — it fetches the draft straight from the repo and renders it like a real post, right on the site. Read it like you would any junior writer's draft — the one thing worth actually checking is that any specific venue facts match reality — then hit **Publish** to flip `draft: true` to `false` and commit, or **Discard** to delete the file entirely if it's not worth keeping. Vercel rebuilds automatically after publishing (usually a couple minutes) and it's live.

If you'd rather hand-edit the text before publishing, the generator's success message still includes a link to open the raw file in GitHub's own editor.

**Cost per post:** roughly a few cents of Claude API usage. No other per-post cost.

## What's still a manual/human step, on purpose

- Nobody's post goes live without a human flipping `draft` to `false` — there's no auto-publish path, by design (unsupervised AI content about real, specific local businesses is the one place small factual errors do real damage to trust).
- The generator only knows verified facts about venues you explicitly tag by slug. Anything else it writes about a specific business should be treated as unverified until you check it.
