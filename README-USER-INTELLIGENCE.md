# User intelligence and product analytics

The super-admin Users page lives at `/admin/users/`. It is available through
the same two-email admin gate as the other admin pages.

## Data boundaries

- PostgreSQL is authoritative for accounts, permissions, restaurant access,
  lists, alerts, consent, session summaries, notification totals, and audits.
- `product_analytics_events` contains a small allowlisted event stream. It does
  not accept arbitrary client properties.
- PostHog is optional. When configured, it receives only the internal UUID as
  `distinct_id`, the analytics session UUID, and allowlisted non-sensitive
  properties. It is never required for an account-management operation.
- Exact coordinates are used only long enough to select one broad market area.
  Only that area key is persisted. Revoking area analytics deletes the user's
  linked area rows.

## Account lifecycle

- Inactive accounts cannot sign in and all current sessions are revoked.
- Anonymization removes credentials and direct identifiers. Custom lists and
  verified restaurant claims must be transferred to a different active user.
- The two site-admin accounts and the acting admin's own account are protected
  from lifecycle changes.
- Every lifecycle change is written to `admin_user_actions`.

## Reporting definitions

- A product session ends after 30 minutes without activity.
- The browser touches activity at most every five minutes while visible.
- Admin engagement totals use the selected 7, 30, or 90 day window.
- Notification `sent`, provider-confirmed `delivered`, `failed`, and local
  `simulated` counts are separate. Delivery webhooks can increment delivered
  counts later without changing the dashboard schema.
- Merchant audience reporting should expose an area only at 20 or more active
  consented users. The current market panel is super-admin-only.

## Setup

1. Run `npm run migrate`.
2. Optionally create a PostHog project and set `POSTHOG_PROJECT_API_KEY`.
3. Set `POSTHOG_HOST` if the project uses a non-default ingest region.
4. Keep session replay disabled unless a later privacy review explicitly
   approves the routes and masking configuration.

