# Venue newsletter ingestion with Resend

This pipeline subscribes a dedicated Resend Receiving address to venue mailing
lists, confirms conservative double-opt-in messages, and turns inbound venue
newsletters into source-grounded candidates for the existing always-current
content engine. It does not use or read a personal inbox.

## Flow

1. `newsletters:inventory` builds a resumable, domain-deduplicated target list
   from every published venue with an official website. It also adds highly
   reviewed, 4.2+ star unlisted San Diego candidates from the existing Google
   Places enrichment cache.
2. `newsletters:signup` finds conservative newsletter forms. Dry-run is the
   default; `--apply` submits them. Each publisher receives a unique alias on
   the Resend Receiving domain, so inbound mail maps back to one subscription
   without relying on an unpredictable ESP sender address.
3. Resend sends an `email.received` webhook to the public relay at
   `/resend/newsletter-email`. The route verifies the Svix
   signature, retrieves the message body from Resend's Receiving API, and
   deduplicates the Resend email ID in Postgres.
4. Known first-party links and inert, sanitized newsletter prose become
   `RawSourceItem` inputs to the existing normalize → dedupe → cluster → draft
   pipeline. Dated events and undated evergreen venue updates both reach the
   admin review queue. Auto-publishing safety remains unchanged.

Resend's receiving webhook contains metadata only; the application retrieves
HTML/text through `GET /emails/receiving/:email_id`, as documented in
[Resend Receiving](https://resend.com/docs/dashboard/receiving/introduction).

## One-time Resend setup

1. In Resend, enable Receiving on either the account's `*.resend.app` domain or
   a dedicated custom subdomain. Using an inbound subdomain avoids replacing
   MX records for an existing mailbox domain.
2. Choose one base address on that receiving domain, for example
   `newsletters@<receiving-domain>`. Resend Receiving accepts arbitrary local
   parts; the signup agent derives a stable, isolated alias for every venue.
3. Add a Resend webhook for `email.received` pointing to:

   ```text
   https://happyhoursd-newsletter-relay.netlify.app/resend/newsletter-email
   ```

4. Configure these Netlify environment variables and the equivalent local
   values only when running the scripts locally:

   ```text
   RESEND_API_KEY=...
   RESEND_RECEIVING_ADDRESS=newsletters@<receiving-domain>
   RESEND_WEBHOOK_SECRET=whsec_...
   RESEND_WEBHOOK_ID=...
   NEWSLETTER_REPLAY_TOKEN=... # secret, relay only
   ```

5. Apply the database migration:

   ```sh
   npm run migrate
   ```

## Build and review the target inventory

```sh
npm run newsletters:inventory
```

Defaults for popular unlisted candidates are 4.2+ stars, 50+ reviews, and the
top 100 records by review count. They can be changed without editing code:

```sh
npm run newsletters:inventory -- \
  --popular-limit=200 \
  --popular-min-rating=4.3 \
  --popular-min-reviews=250
```

The resumable working file is `.data/newsletters/inventory.json`. It is local
operational state and is not committed.

## Canary, then batch signup

First discover one form without submitting it:

```sh
npm run newsletters:signup -- --limit=1 --headed
```

After reviewing the result, submit one canary and sync its ledger state:

```sh
npm run newsletters:signup -- --apply --limit=1 --headed
npm run newsletters:sync
```

Then increase the batch size. The inventory is rewritten after every domain,
so interrupted runs resume safely:

```sh
npm run newsletters:signup -- --apply --limit=25
npm run newsletters:sync
```

Forms with extra required identity fields, CAPTCHA/bot checks, or ambiguous
consent stay in `manual_required`. A conservative `no_newsletter` result is
also retained rather than guessing that a contact form is a mailing list.

## Operations and safety

- All publisher mail goes to the Resend receiving domain, never a personal
  mailbox.
- Webhooks are signature-verified and Resend email IDs are idempotent.
- An operator-only replay endpoint can recover a missed Resend delivery by
  email ID. It requires the relay's secret bearer token and feeds the message
  back through the same signature verification and idempotency checks.
- Email HTML is sanitized and treated as untrusted data. Embedded instructions
  cannot select a source, arbitrary URL, or model behavior.
- Only mapped recipients and allowlisted first-party domains are eligible for
  content ingestion.
- Confirmation automation follows at most one clearly identified subscription
  confirmation URL. Ambiguous, security-related, or challenged messages remain
  manual.
- Newsletter-derived drafts remain review-first. Undated ideas retain the
  `missing_event_date` quality flag, which blocks auto-publishing.

## Verification

```sh
npm run test:newsletter-ingestion
npm run test:content-engine
npm run build
```
