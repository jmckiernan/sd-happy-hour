# Product Roadmap

## Scope

This roadmap turns the white paper thesis into product work. The near-term goal is still a San Diego happy hour and deals product. The long-term goal is a real-time local demand network for venues and consumers.

## Strategy Principles

1. Build consumer utility before asking merchants to participate.
2. Treat sharing, alerts, and lists as growth infrastructure, not side features.
3. Keep the merchant experience simple at first and expand only after the core loop works.
4. Use live promotions as the bridge between discovery and monetization.
5. Design the data model so the app can expand from restaurants into broader venue categories without rework.

## Product Pillars

| Pillar | What it means | Why it matters |
| --- | --- | --- |
| Discovery | Fast ways to find happy hours, deals, events, and places to go now | This is the wedge and the daily consumer use case |
| Sharing | One-tap sharing of venues, deals, lists, and content | Sharing is the core distribution loop |
| Alerts | Venue, area, and search-based notifications with quiet hours | Alerts create retention and permissioned reach |
| Merchant Actions | Claiming, creating promotions, scheduling, and upgrading | This turns the product into revenue infrastructure |
| Analytics | Clear reporting for consumer activity and merchant results | Analytics is the sales story for restaurants |
| Content Engine | SEO and editorial content tied back to live listings | Content drives discovery and acquisition |

## Roadmap Phases

### Phase 1 - Foundation

The goal in this phase is to make the current product more shareable, more subscribable, and more measurable.

Deliverables:

1. Shared custom lists with collaboration and live sync.
2. One consistent share action on venue, deal, list, and blog pages.
3. Alert preferences for live deals, happy hours, and events.
4. Quiet hours and a global pause toggle for alerts.
5. Merchant upgrade path when the free campaign limit is reached.
6. Better internal support for source provenance and freshness.
7. Merchant-facing analytics skeleton with first-party event tracking.

Exit criteria:

1. Users can create and share lists with other users.
2. Users can subscribe to specific alert types without confusion.
3. Merchants can reach an upgrade page instead of a dead end.
4. The system can report shares, follows, saves, clicks, and alert signups.

### Phase 2 - Merchant Monetization

The goal here is to turn merchant activity into a real commercial loop.

Deliverables:

1. Stripe-backed subscription and upgrade flow.
2. Merchant plan tiers with clear feature gating.
3. Live promotion publishing with scheduled and immediate starts.
4. Outbound promotion links for tickets, reservations, and partner sites.
5. Campaign-level analytics for views, clicks, calls, directions, and claims.
6. Founding partner beta controls and promotional credits.

Exit criteria:

1. A merchant can upgrade without manual intervention.
2. A merchant can launch a promotion with a primary CTA and optional external link.
3. The dashboard can show early ROI signals without custom spreadsheet work.

### Phase 3 - Demand Network

The goal here is to convert the product into an audience and distribution system for venues.

Deliverables:

1. Collaborative lists as a social object.
2. Share links with attribution tracking.
3. Venue follow counts and saved-search audiences.
4. Merchant recommendations based on audience and timing.
5. Content modules that turn the same venue data into SEO pages, blog posts, and social assets.
6. Expanded analytics with conversion proxies and estimated impact.

Exit criteria:

1. The app can show why a merchant should pay again.
2. Shared content drives measurable new users.
3. Merchants understand the difference between their existing followers and incremental reach.

### Phase 4 - Category Expansion

The goal here is to move from happy hour to a broader local demand platform.

Deliverables:

1. Support for breweries, coffee shops, entertainment venues, and ticketed events.
2. Offer types beyond happy hour, including live music, trivia, game day, and special events.
3. Category-specific landing pages and content clusters.
4. City expansion playbook that can be reused market by market.

Exit criteria:

1. The model works for multiple venue types.
2. The same product loop still works outside traditional happy hour.
3. A new city can be launched with the same operating system.

## Priorities By Impact

| Priority | Work | Rationale |
| --- | --- | --- |
| Highest | Sharing, lists, alerts, upgrade path | These are the highest leverage retention and growth features |
| High | Merchant billing, promotion publishing, analytics | These unlock revenue and validation |
| Medium | Content engine and automated ingestion | These drive scale and search acquisition |
| Medium | Collaboration and creator workflows | These deepen virality after the core loop works |
| Later | Advanced optimization, forecasting, paid boosts | These depend on enough merchant volume and data |

## Product Decisions To Keep Stable

1. `HAPPY HOUR NOW` stays a computed consumer state.
2. `LIVE` stays a promotion state, not a venue toggle.
3. Lists can be private, shared, or collaborative.
4. Alert families stay simple at the user level.
5. Merchant monetization should start with clear limits and upgrade paths, not hidden enforcement.

## Success Metrics

Consumer:

1. Weekly active users.
2. Searches per user.
3. Venue follows.
4. List shares.
5. Alert subscriptions.
6. Notification open and click rates.

Merchant:

1. Listings claimed.
2. Promotions launched.
3. Upgrade conversion.
4. Repeat campaign usage.
5. Clicks, calls, directions, and claims.

Distribution:

1. Organic search traffic.
2. Share-driven sessions.
3. Creator-driven sessions.
4. Venue-driven sessions.
5. Referral conversion.

