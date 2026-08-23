# Live Alerts: Restaurant Accounts & Notifications — Setup Guide

This builds on the saved-alert filters from `README-ACCOUNTS-SETUP.md` (`/alerts/`) with the two pieces needed to make them actually fire: restaurant accounts that can mark a listing live, and the email/text dispatch that notifies matching alerts when that happens.

- **Restaurant sign-in** at `/restaurant/` — no separate account. Restaurants sign in exactly the way consumers do (Google, or email/password), then claim a specific listing from the dashboard. Verification is scoped to *that venue*: if the signed-in account's email domain matches the venue's own website domain (from `public/data/happy-hours.json`), the claim verifies instantly. Otherwise it goes into a review queue at `/admin/restaurants/` (sign in at `/account/` with an admin email — same admin list as everything else, see `README-ACCOUNTS-SETUP.md`). A single account can hold verified claims on more than one venue.
- **Claiming a listing** — search for it from the dashboard and submit a claim. At most one account can hold a *verified* claim on a given venue at a time (`venue_claims_verified_venue_unique` in the database enforces this), which is the actual fix for the earlier design where verifying once let an account claim any venue afterward — see "Known limitations" below for what's still not covered.
- **Going live** — once a claim is verified, tap "We're live now" to mark that listing live immediately (auto-expires after 4 hours so a forgotten toggle doesn't stay on forever). This is on top of the normal weekly schedule already in `public/data/happy-hours.json` — either one showing "live" is enough to trigger alerts and the site's Live Now badge.
- **Alert dispatch** — every 15 minutes, a scheduled job checks for live venues, matches them against everyone's active alerts, and sends each user at most one consolidated email and one consolidated text covering everything that matched (never one message per alert or per venue — see "Why batching" below).

## Local development needs zero setup

Same philosophy as accounts/blog: `npm run dev` works immediately. Without `RESEND_API_KEY` or `TWILIO_*` set, emails and texts are *logged to the console instead of sent* (see `src/lib/email.ts` / `src/lib/sms.ts`) — the whole matching/dispatch pipeline still runs and is testable, it just doesn't deliver anything. You can trigger a dispatch run manually anytime from `/admin/` → **Send alerts now**, rather than waiting on the 15-minute schedule.

## One-time setup for deploying

Restaurant managing-user invitations use the same email delivery path as alerts. Owners can invite an email that does not yet have an account; the recipient receives a seven-day acceptance link and must register or sign in with that exact address. Without Resend configuration the invitation is still recorded, but delivery is simulated in the server log.

### 1. Email — Resend

Free and unlimited per user (no cap on the email side — see "Why text is capped" below). Create a free account at [resend.com](https://resend.com), verify a sending domain, and set:

```
RESEND_API_KEY=
RESEND_FROM_EMAIL="SD Happy Hours <alerts@sdhappyhours.com>"
```

### 2. Text — Twilio

Set up a **toll-free number with toll-free verification**, not a full 10DLC campaign — toll-free is faster and cheaper to stand up at this app's volume (roughly $2/month flat for the number itself, versus 10DLC's ~$50-65 in one-time registration/vetting fees plus a few dollars a month ongoing). Move to 10DLC only if you outgrow toll-free's throughput limits. Then set:

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
```

### 3. Scheduled dispatch function

The 15-minute dispatch job (`netlify/functions/dispatch-alerts.mts`) is a **standalone Netlify Function**, not part of the Astro app — Netlify's `schedule` config only works on functions declared that way, not on Astro API routes. It's wired up in `netlify.toml`:

```toml
[functions]
  directory = "netlify/functions"

[functions."dispatch-alerts"]
  schedule = "*/15 * * * *"
```

Nothing else to configure — Netlify picks this up automatically on deploy. You can confirm it's running under **Functions** in the Netlify dashboard, or just watch `/admin/` → **Send alerts now** work the same way manually.

Because this function isn't built through Astro/Vite, it can't use `import.meta.env` — everything it touches (via `runAlertDispatch()` in `src/lib/notify.ts`) reads env vars through `kv.ts`'s `getEnv()` helper, which checks `process.env` too for exactly this reason. If you add new env-var-dependent code that this dispatch path touches, read it through `getEnv()`, not `import.meta.env` directly, or it won't see the value here.

### 4. Requires real KV configured

The dispatch job needs to read every user's alerts and write to the live-overrides/notification-log stores on every run. The local `.data/` JSON fallback (see `README-ACCOUNTS-SETUP.md`) only works for a single persistent process like `astro dev` — it's meaningless for a function that runs fresh every 15 minutes in production. Deploying the live-alerts feature for real requires `KV_REST_API_URL`/`KV_REST_API_TOKEN` to already be set up (same Upstash store used for accounts).

## Why text is capped and email isn't

Twilio charges per message segment (~$0.0079 in the US) plus small carrier fees — small per message, but it adds up fast if one user has several broad alerts each firing independently. Email has no comparable per-send cost at this scale (Resend's free tier alone covers 3,000/month). So the dispatch engine (`src/lib/notify.ts`) treats them very differently:

- **Email:** sent for every match, no cap.
- **Text:** requires the user to have added a phone number and opted in (per-alert), and is capped at `SMS_DAILY_CAP_PER_USER` (default 2) actual *messages* per user per day — not per venue. Once a user hits the cap, further matches that day still go out by email.

### Why batching

Rather than sending a message the instant any one restaurant goes live, each dispatch run collects everything currently live, matches it against every active alert, and sends **one** consolidated email and **one** consolidated text per user per run — covering every match, deduplicated across alerts. A user with 5 broad alerts catching several matches a day would otherwise generate dozens of texts; batched into 15-minute windows with a daily cap, the same user generates at most `SMS_DAILY_CAP_PER_USER` texts total, no matter how many things match. There's also a 3-hour cooldown per (user, venue, channel) so a happy hour that stays live for hours doesn't re-trigger a message on every single run for its whole duration.

## Known limitations (deliberate, for now)

- **No phone verification yet.** The fallback for restaurants that don't run email off their own domain is manual admin review (a supporting-info note), not a texted verification code — that would need a curated phone number per venue in `public/data/happy-hours.json`, which doesn't exist today. `venue_claims.phone`/`phone_code`/`phone_code_expires_at` are already in the schema for when that data exists; nothing reads or writes them yet.
- **New listings still go through `/submit/`.** A restaurant with no existing listing needs one created and approved the normal way (see `README-ACCOUNTS-SETUP.md`) before they have anything to claim. Wiring submission approval to automatically create a verified claim for the submitting account is a reasonable follow-up, not built here.
- **SMS opt-in UI isn't built yet.** The data model supports it (`User.phone`, `User.smsConsentAt` in `src/lib/kv.ts`, and each alert's `channels.text` flag), but there's no form yet for a user to add/verify a phone number — that's needed before the text channel does anything for a real user. The dispatch engine already handles the "no phone on file" case gracefully (falls through to email-only).
- **`isHappeningNow` is duplicated.** The homepage's live-badge check (`src/pages/index.astro`) uses the visitor's browser clock; the dispatch engine's version (`src/lib/venues.ts`) explicitly pins to Pacific time since it runs on a server with no "visitor" to borrow a clock from. They should behave the same in practice for a San-Diego-local audience, but they're two separate implementations, not one shared one.
