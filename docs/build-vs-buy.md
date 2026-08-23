# Build vs Buy Recommendations

## Executive Summary

The right approach is mixed. Buy or rent the systems that are commodity infrastructure. Build the parts that create the local network effect and the merchant value proposition.

## Recommendations

| Area | Recommendation | Why |
| --- | --- | --- |
| Billing and subscriptions | Buy | This is a solved problem and should not distract the team |
| Customer portal | Buy | Merchants should self-manage payment details and plans |
| Product analytics | Buy | Faster to get reliable event tracking, session replay, and dashboards |
| Merchant ROI dashboard | Build | This is product-specific and must reflect your unique funnel |
| Alert delivery | Buy plus integrate | Email and SMS delivery are commodity, but preference logic is custom |
| Venue data enrichment | Mix | Use APIs and third-party sources, then normalize and verify internally |
| Content publishing | Build | The editorial strategy is a growth asset |
| Sharing and referrals | Build | This is core to the viral loop |
| List collaboration | Build | This is part of the consumer social graph |
| Map and place data | Buy | External place data is faster and usually more accurate than hand entry |

## Billing

Recommended path:

1. Use Stripe Billing for subscriptions and plan management.
2. Use Stripe Checkout or a similar hosted checkout flow.
3. Use the customer portal for self-service billing changes.
4. Keep entitlement logic in your app so features can be gated independently of the payment provider.

Why:

1. You get trials, plans, invoices, and proration without custom billing code.
2. Merchants can update payment methods themselves.
3. You can later add usage-based or hybrid pricing without a rewrite.

## Analytics

Recommended path:

1. Use a product analytics platform for event capture and funnels.
2. Build your own merchant reporting layer on top of your event data.
3. Add warehouse-style storage once the reporting patterns stabilize.

Why:

1. Merchant-facing analytics should not be locked to a generic dashboard.
2. You need custom attribution for clicks, claims, directions, calls, and redemptions.
3. A merchant dashboard will eventually need local context that generic tools do not know about.

## Alerts

Recommended path:

1. Use a provider for email and SMS delivery.
2. Build your own preference engine, quiet hours, pause controls, and matching rules.

Why:

1. Deliverability and phone/email infrastructure are commodity layers.
2. The business value is in deciding who gets what, when, and why.

## Venue Data

Recommended path:

1. Use external place APIs to seed name, address, hours, category, and photo data.
2. Use venue websites, schema markup, and merchant edits to improve coverage.
3. Store source provenance and freshness metadata for each field.
4. Add manual review only where the automated confidence score is low.

Why:

1. You need scale quickly.
2. Local business data changes frequently.
3. A provenance trail lets you resolve conflicts without losing trust.

## Content And SEO

Recommended path:

1. Build the content engine in-house.
2. Use automation to assist drafting and sourcing.
3. Keep editorial control over final publication.

Why:

1. The content strategy is part of the product's distribution moat.
2. The best content will link directly into your venue and list experience.
3. Off-the-shelf tools will not understand your local editorial strategy well enough.

## Sharing And Lists

Recommended path:

1. Build share links, list collaboration, and referral tracking yourself.
2. Use the browser's native share capability where available.
3. Fall back to copy-link and channel-specific deep links.

Why:

1. Sharing is not just a convenience feature.
2. It is one of the product's main acquisition loops.

## What Not To Build Too Early

1. A bespoke billing backend.
2. A full custom BI stack before the event model is stable.
3. A complex prediction engine before enough performance data exists.
4. A fully automated ingestion system without review gates.
5. A heavy merchant CRM before the upgrade and campaign loop works.

## Build Sequence

1. Buy infrastructure that is already standardized.
2. Build the local demand logic.
3. Build the merchant dashboard and reporting surface.
4. Build the content and sharing flywheel.
5. Add optimization layers only after enough usage exists.

