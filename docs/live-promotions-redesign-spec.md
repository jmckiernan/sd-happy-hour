# Live Promotions & Alert Model Redesign

## Authoritative Implementation Specification

This document is the source of truth for the redesign of regular happy hours, Live Deals, merchant promotions, and consumer alerts.

Agents working on this feature must read this entire document before planning or implementing changes. Do not selectively implement sections without considering the complete specification.

# SD Happy Hours — Live Promotions & Alert Model Redesign

## Objective

Refactor the current happy-hour/live/promotion system so that four concepts are clearly separated throughout the data model, APIs, merchant dashboard, consumer UI, and notification system:

> **Regular Happy Hour = recurring venue inventory**

> **Promotion = a special temporary merchant-created offer**

> **Live = the active state of a promotion**

> **Boost = optional paid distribution beyond the venue's existing followers / organic audience**

The existing user-facing happy-hour experience must continue to work.

Users must still be able to receive notifications about ordinary scheduled happy hours.

This work should **not** merge the permanent listing-management experience into the promotional dashboard. Permanent happy-hour hours, regular deals, photos, menus, etc. should remain under the existing listing-management workflow.

---

# Important Working Instructions

Before changing anything:

1. Inspect the entire repository relevant to this feature.
2. Read the current database migrations and schema.
3. Read:

   * `src/pages/restaurant.astro`
   * `src/pages/restaurant/manage/[slug].astro`
   * `src/pages/index.astro`
   * `src/pages/venues/[slug].astro`
   * `src/lib/store.ts`
   * `src/lib/notify.ts`
   * `src/lib/venues.ts`
   * `src/pages/api/live-status.ts`
   * `src/pages/api/promotions.ts`
   * `src/pages/api/restaurant/live.ts`
   * `src/pages/api/restaurant/promotion.ts`
   * alert APIs under `src/pages/api/account/alerts/`
   * `src/pages/account.astro`
   * `README-NOTIFICATIONS-SETUP.md`
   * all existing migrations.
4. Identify every place that currently uses:

   * `live_overrides`
   * `promotions`
   * `isVenueLive`
   * `isHappeningNow`
   * Live Now badges
   * notification matching
   * promotion data
5. Produce a short implementation plan before editing.
6. Preserve working functionality that is unrelated to this redesign.
7. Use migrations rather than editing previously applied migrations as though they had never existed.
8. Do not add payment processing yet unless payment infrastructure already exists and is required for the feature. Represent usage/entitlement in a way that can support billing later.
9. Keep the code extensible beyond restaurants. Prefer `venue` and `promotion` concepts internally where practical.
10. Add tests for the state logic and notification behavior before considering the work complete.

---

# 1. Product Model

The application currently has several overlapping meanings for “Live.”

Replace that conceptual model with the following.

## A. Regular Happy Hour

A recurring happy-hour schedule belonging to a venue.

Example:

> Monday–Friday
> 4:00 PM–6:00 PM
> $8 cocktails
> $5 draft beer
> $6 wine

This is normal venue information.

It is not a merchant advertising campaign.

It should continue to be managed through the existing listing-management area.

---

## B. Happy Hour Now

This is a **computed consumer-facing status**, not a database object.

When the current San Diego time falls inside one of the venue's normal recurring happy-hour windows:

> **HAPPY HOUR NOW**

This should happen automatically.

No merchant action is required.

Do **not** call this `LIVE NOW`.

---

## C. Promotion

A temporary merchant-created marketing offer.

Examples:

> $5 margaritas until 7 PM

> Padres pregame — free appetizer with two drinks

> Happy hour extended until 8 PM tonight

> Half-price pastries from 2–4 PM

> $10 tickets for tonight's comedy show

A promotion has its own:

* title
* description
* optional deal/redemption code
* type
* start time
* end time
* status
* venue
* creation timestamp
* update timestamp

A promotion is separate from the venue's normal happy-hour deals.

---

## D. Live Promotion

“Live” is **not a venue boolean**.

It is a computed state of a promotion.

A promotion moves through:

> Draft → Scheduled → Live → Ended

Optional future states may include:

> Cancelled

The promotion is `Live` when:

> `starts_at <= now < ends_at`

unless cancelled.

If a merchant creates a promotion and chooses **Start Now**, set `starts_at` to the current timestamp.

If they schedule it for later, it automatically becomes Live when its start time arrives.

No separate venue-level `We're live now` toggle should be required.

---

## E. Boost

Boost is a future/paid distribution layer attached to a promotion.

It should **not** be necessary to complete payment functionality in this redesign.

Architect the promotion so a future campaign/distribution layer can be attached without redesigning the promotion itself.

The conceptual distinction is:

> Promotion = what the merchant is offering.

> Live = whether that offer is currently active.

> Boost = how much incremental distribution the merchant purchases.

---

# 2. Consumer Alert Model

Keep consumer notification choices intentionally simple.

There should be only **two primary alert families** initially.

## Alert Family 1 — Happy Hour Alerts

Purpose:

> Tell me about normal recurring happy hours that match what I care about.

Examples:

> A saved/followed venue's normal happy hour is starting.

> Happy hours matching my North Park + cocktails search are starting.

> Restaurants matching one of my saved alert filters are now in their normal happy-hour window.

These come from the recurring venue happy-hour schedule.

They do **not** require a merchant-created promotion.

---

## Alert Family 2 — Special Deal Alerts

Purpose:

> Tell me when venues launch special temporary promotions.

This includes:

* Live Promotions
* flash deals
* extended happy hours
* game-day offers
* temporary specials
* event promotions
* future promotion types

Do not make users independently configure every promotion subtype yet.

Internally, promotion types may exist.

Consumer-facing notification preferences should group them under:

> **Special Deals & Live Promotions**

This keeps the product understandable.

---

# 3. Alert Preference UX

For a user following a specific venue, provide two simple controls:

## Notifications from Craft & Commerce

**Happy Hour Alerts**
`[ on/off ]`

> Tell me when Craft & Commerce's regular happy hour is starting.

**Special Deal Alerts**
`[ on/off ]`

> Tell me when Craft & Commerce launches a special Live promotion or limited-time offer.

Optional channel choices can remain separate:

> Email
> Text
> Push later

Do not force a user who wants special promotions to also receive normal happy-hour reminders.

Do not force a user who wants happy-hour reminders to receive merchant promotions.

The choices are independent.

---

# 4. Saved Search Alerts

The app already supports filter-based alerts.

Preserve that capability.

Add an alert-content preference to each saved alert.

A saved alert should support something equivalent to:

```text
alertKinds:
- happy_hour
- promotion
```

The user may select:

> Regular happy hours

> Special deals & promotions

> Both

Do not require creating two separate saved alerts when one filter set can listen for both event types.

Example:

### North Park Cocktail Deals

Filters:

> Neighborhood: North Park
> Deal: Cocktails
> Friday

Notify me about:

> ☑ Regular happy hours
> ☑ Special deals & promotions

Channels:

> ☑ Email
> ☐ Text

---

# 5. Following a Venue vs Saving a Venue

Do not automatically assume that simply saving/favoriting a restaurant means the user wants notifications.

Keep these concepts distinct:

> Saved/Favorite = I want to remember this place.

> Follow/Notifications = I want you to contact me about this place.

If venue-following does not yet exist as a separate persisted relationship, add a clean representation for it rather than overloading `saved_spots`.

A venue-follow relationship should support at minimum:

```text
user_id
venue_id
happy_hour_alerts_enabled
promotion_alerts_enabled
created_at
updated_at
```

Channel behavior may either:

1. inherit the user's global/default channels, or
2. be stored per follow if the current architecture makes that cleaner.

Prefer the simpler implementation consistent with the existing alert system.

---

# 6. Notification Behavior

Regular happy-hour notifications and promotion notifications must have different trigger semantics.

## Regular Happy Hour

A normal happy hour should notify once around the beginning of the relevant occurrence.

Do not repeatedly notify someone every 15 minutes while the same normal happy hour remains active.

The system needs a deduplication identity that represents the specific occurrence, for example:

> venue + happy-hour occurrence date/start + alert type + user + channel

---

## Live Promotion

A promotion should notify when that specific promotion becomes Live.

The notification identity should include the **promotion ID**, not merely the venue ID.

This is critical.

A venue may legitimately run:

> Promotion A at 3 PM

and later:

> Promotion B at 7 PM.

The current notification log is venue-centric and could incorrectly suppress a second legitimate campaign.

Refactor notification deduplication so event identity can distinguish different promotions and normal happy-hour occurrences.

---

# 7. Notification Delivery Priority

The long-term behavior should support an important distinction.

## Followed Venue Promotion

If the user explicitly follows the venue and enables Special Deal Alerts:

> notify them whenever a legitimate new promotion goes Live.

These are requested notifications.

They should not be treated as optional paid reach from the merchant.

---

## Targeted Non-Follower Promotion

Future functionality may allow merchants to pay to reach relevant users who do not follow the venue.

Do not implement paid targeting in this phase unless already supported.

However, keep the architecture capable of later distinguishing:

```text
distribution_source:
organic_follow
saved_alert
paid_boost
```

---

# 8. Promotion Database Redesign

The current promotion storage allows effectively one promotion record per venue.

Replace this with a proper promotion entity capable of holding multiple historical and scheduled promotions.

Create a new migration.

Suggested conceptual schema:

```text
promotions

id UUID primary key
venue_id integer not null
type text not null
title text not null
description text not null
deal_code text nullable
starts_at timestamptz not null
ends_at timestamptz not null
status text
created_by_user_id / owner reference where appropriate
created_at timestamptz
updated_at timestamptz
cancelled_at timestamptz nullable
```

Do not rely purely on a manually maintained status column for time-derived state if that creates synchronization problems.

Prefer helper logic such as:

```text
getPromotionState(promotion, now)
```

which returns:

* draft
* scheduled
* live
* ended
* cancelled

based on persisted attributes.

If drafts need nullable start/end dates, design accordingly.

---

# 9. Promotion Types

Support a small extensible set initially.

Suggested initial values:

```text
special_deal
extended_happy_hour
event
other
```

Do not build a huge category system yet.

The schema/API should permit future types such as:

```text
flash_deal
game_day
brunch
live_music
trivia
coffee_special
last_minute
```

without redesigning the entire model.

---

# 10. Deal Codes

Deal codes should be **optional**.

Do not require a code for every promotion.

A restaurant may simply run:

> $5 margaritas until 7 PM

without requiring the consumer to say a code.

Support:

```text
deal_code = null
```

If a deal code exists, preserve the existing behavior of protecting it appropriately if that remains the intended product behavior.

---

# 11. Retire the Venue-Level Live Override Concept

The current manual `live_overrides` model should no longer drive merchant promotions.

Do not delete historical functionality blindly.

First identify every dependency.

Then migrate the application away from:

> merchant sets venue `active=true`

toward:

> merchant creates/starts a Promotion.

After all consumers are migrated, either:

1. remove `live_overrides` in a later migration, or
2. leave it temporarily deprecated with no active product usage if safer.

Do not leave two competing systems indefinitely.

---

# 12. Shared Time Logic

There is currently duplicated “is happening now” behavior between consumer rendering and server notification code.

Create a shared source of truth for San Diego time-based status.

Implement reusable functions such as:

```text
isHappyHourActive(venue, now)
getActiveHappyHourOccurrence(venue, now)
getPromotionState(promotion, now)
isPromotionLive(promotion, now)
```

All server and client behavior should derive from the same rules wherever practical.

Be explicit about:

> America/Los_Angeles

and daylight-saving behavior.

Do not depend accidentally on the server machine's local timezone.

---

# 13. Merchant Dashboard Redesign

The main `/restaurant/` page should become a lightweight merchant command center.

Permanent editing stays linked separately.

For each verified venue card, show:

## Venue Header

> Craft & Commerce

> VERIFIED

Links:

> **Manage listing, photos & menu →**

> **View public page →**

These remain.

---

# 14. Today's Regular Happy Hour

Add a small informational section:

### Today's Happy Hour

> 4:00 PM–6:00 PM

Possible state:

> Starts in 2h 10m

or:

> **HAPPY HOUR NOW — ends at 6 PM**

or:

> No regular happy hour today

This is informational.

The merchant does not toggle it.

---

# 15. Promotions Command Center

Replace:

> `We're live now` toggle

and the current standalone promo form

with:

# Promotions

If none are Live:

> **No promotion currently Live**

Buttons:

> **Launch Live Promotion**

> **Schedule Promotion**

Also show usage:

> **1 complimentary Live promotion remaining this month**

For now, this allowance may be mocked/configured or represented as an entitlement without payment collection.

Do not make billing a prerequisite for the redesign.

---

# 16. Active Promotion Card

If one is currently Live:

### 🔴 LIVE PROMOTION

> $5 Margaritas + $2 Tacos

> Ends at 7:00 PM

Actions:

> Edit if safe

> End promotion

> View public page

Potential future data placeholder:

> 487 followers eligible for Live alerts

Do not display fake metrics unless real data is available.

---

# 17. Scheduled Promotions

Create a section:

# Scheduled

Each card shows:

> Promotion title

> Date

> Start/end time

> Type

Actions:

> Edit

> Start now

> Cancel

If Start Now is pressed:

* change start time to now
* preserve/ask for appropriate end time
* make it Live immediately.

---

# 18. Past Promotions

Create:

# Past Promotions

Show recently completed/cancelled campaigns.

Initially:

> Title
> date/time
> status

Build the UI so analytics can later appear:

> notifications delivered
> opens
> venue views
> directions
> claims
> redemptions

Do not invent analytics values before instrumentation exists.

---

# 19. Promotion Creation UX

Clicking **Launch Live Promotion** or **Schedule Promotion** should open a compact form/modal/page.

Fields:

### Promotion Type

> Special Deal
> Extended Happy Hour
> Event
> Other

### Headline

Example:

> $5 Margaritas + $2 Tacos

Keep this concise because it appears on cards and notifications.

### Details

Optional additional explanation:

> Bar seating only. While supplies last.

### When

For Launch:

> Start now

For Schedule:

> date + start time

### End Time

Required.

Do not allow an indefinite Live promotion.

### Deal Code

Optional.

### Preview

Show approximately how the consumer card/banner will appear.

---

# 20. Launch Confirmation

Before actually launching a promotion, show:

> **Ready to go Live?**

> $5 Margaritas + $2 Tacos

> Now–7:00 PM

If real audience counts are available:

> 487 followers have Special Deal Alerts enabled.

If counts are not yet implemented, do not fabricate them.

Button:

> **GO LIVE**

Launching should create the promotion and make it immediately eligible for promotion-alert dispatch.

---

# 21. Homepage Visual Hierarchy

The homepage must visually distinguish normal active happy hours from merchant promotions.

## Normal recurring happy hour

Replace the existing green `LIVE NOW` treatment with something like:

> **HAPPY HOUR NOW**

Use a noticeable but less dominant treatment.

Do **not** use the strongest green glow for ordinary scheduled happy hour.

---

## Live Promotion

Reserve the strongest visual treatment for merchant-created promotions.

Use:

> **● LIVE PROMO**

or:

> **● LIVE DEAL**

Recommended terminology for consumers:

> **LIVE DEAL**

This may be more immediately understandable than “Live Promotion.”

The card should show the actual promoted offer prominently:

> **$5 Margaritas + $2 Tacos**

and:

> **Ends in 1h 24m**

A Live Deal should visually outrank a normal happy-hour status.

---

# 22. When Both Are Active

A venue may simultaneously have:

1. its regular happy hour active, and
2. a merchant-created Live promotion.

This is valid.

The UI hierarchy should be:

### Primary

> 🔴 LIVE DEAL

> $5 Margaritas Until 7 PM

### Secondary

> Regular happy hour also happening until 6 PM

Do not display two competing “live” badges.

---

# 23. Dedicated Live Deals Page

Add a dedicated `/live-deals/` discovery page, linked from the primary navigation:

# Live Deals

Show currently active merchant promotions.

Each card should include:

* venue
* promotion headline
* neighborhood
* expiration/countdown
* relevant image
* details link

This page exists because Live promotions are exceptional inventory.

The homepage should not duplicate these full promotion cards. Preserve its normal searchable venue grid, including the Live Deal badge, promoted-offer summary, and premium outline on venues that currently have a Live Deal.

On the dedicated page, provide relevant discovery controls such as search and neighborhood filtering.

On the homepage, preserve regular discovery such as:

# Happy Hours Happening Now

or the normal searchable venue grid.

If zero promotions are live, show a clear, compact empty state on the dedicated page.

---

# 24. Search/List Cards

Normal venue card states:

### Neither active

Normal card.

### Regular Happy Hour Active

Badge:

> HAPPY HOUR NOW

### Live Promotion Active

Badge:

> LIVE DEAL

Show promotion headline.

Use premium visual treatment.

### Both Active

Primary badge:

> LIVE DEAL

Secondary text:

> Happy hour also happening now

---

# 25. Public Venue Detail Page

On `/venues/[slug]`:

## Hero Status

For ordinary active happy hour:

> **HAPPY HOUR NOW**

For a Live promotion:

> **LIVE DEAL**

If both are active, the Live Deal gets visual priority.

---

# 26. Promotion Detail Block

When a Live promotion exists, display a prominent block between the hero/action area and normal happy-hour information.

Example:

# 🔴 LIVE DEAL

## $5 Margaritas + $2 Tacos

> Tonight only · Ends at 7:00 PM

> Bar seating only.

If applicable:

> Deal code: HHSD10

Then separately show:

# Regular Happy Hour

> 4:00–6:00 PM
> $8 cocktails
> $5 drafts
> etc.

Do not merge the temporary promotion into the permanent happy-hour deal array.

---

# 27. Permanent Listing Management

Keep:

`/restaurant/manage/[slug]`

focused on permanent/semi-permanent venue information:

* recurring happy-hour schedule
* regular deals
* venue description
* photos
* menu
* other durable listing data

Do not add Live campaign controls to this screen.

Link back to the merchant dashboard if needed:

> **Manage promotions →**

The mental distinction is:

> Listing management = what is normally true about my business.

> Promotions dashboard = what am I doing right now / soon to generate traffic?

---

# 28. Merchant Navigation

As the merchant product grows, prepare for navigation approximately like:

> **Overview**

> **Promotions**

> **Audience**

> **Analytics**

> **Listing**

Do not build empty pages solely for appearance.

For this phase, `Overview/Promotions` may remain combined if that keeps implementation smaller.

But do not architect the listing editor as though it is the entire merchant dashboard.

---

# 29. Public Promotions API

Replace the current venue-keyed single-promotion response with an API capable of returning multiple promotions.

Support queries such as:

```text
active promotions
active promotion for venue
scheduled promotions for merchant
promotion history for merchant
```

Do not expose private merchant information.

Public promotion responses should contain only consumer-facing data.

If deal codes remain gated to signed-in consumers, preserve that rule server-side.

---

# 30. Merchant Promotion APIs

Replace or expand the existing promotion API to support:

### Create promotion

`POST`

### Update draft/scheduled promotion

`PUT/PATCH`

### Cancel/end promotion

`POST/PATCH/DELETE` as appropriate

### List promotions for claimed venue

`GET`

Every mutation must verify that the signed-in user has a verified claim on the corresponding venue.

Do not trust a client-supplied venue ID without authorization.

---

# 31. Usage / Entitlement Foundation

We eventually want:

> one free Live promotion per month

and paid additional campaigns / Pro entitlements.

Do **not** overbuild billing now.

Create a small entitlement/service abstraction capable of answering:

```text
canLaunchPromotion(user/venue)
freePromotionsRemaining
plan
```

Do not scatter checks such as:

```text
if (plan === ...)
```

through every UI and API file.

Centralize promotion eligibility.

For launch/beta, it should be easy to configure:

> Founding Partner = unlimited or credited

> Free = 1 Live/month

> Pro = N included/month

without rewriting promotion logic.

---

# 32. Promotion Usage Accounting

Do not count:

* drafts
* cancelled-before-start promotions

as consumed Live campaigns.

A campaign should count toward usage once it actually becomes Live.

Store enough information to prevent deleting and recreating promotions to avoid quotas.

Exact commercial rules may change, so keep accounting separate from the promotion entity where reasonable.

---

# 33. Notification Event Model

The current notification system is centered around:

> live venue

Refactor toward:

# notification-worthy event

At minimum support two event classes:

```text
happy_hour_started
promotion_started
```

Future examples:

```text
event_starting
saved_venue_update
```

The dispatcher should not need to think that everything is merely a “venue that is live.”

---

# 34. Happy-Hour Alert Matching

For `happy_hour_started`:

Match against:

* active saved-search Happy Hour Alerts
* venue follows where `happy_hour_alerts_enabled = true`

Use the venue's recurring schedule.

Do not send a promotion alert.

---

# 35. Promotion Alert Matching

For `promotion_started`:

Match against:

* users following that venue with `promotion_alerts_enabled = true`
* saved search alerts whose `alertKinds` include `promotion`
* future paid-targeting recipients, not implemented yet

Include the promotion's headline and expiration.

Example email subject:

> Craft & Commerce just launched a Live Deal

Example body:

> $5 Margaritas + $2 Tacos
> Available until 7 PM.

Do not describe it merely as:

> Craft & Commerce is live now.

The offer is the reason the user cares.

---

# 36. Consolidation vs Immediate Notifications

Preserve sensible cost controls, but distinguish between the two use cases.

## General happy-hour saved-search alerts

Batching/digests are acceptable.

For example, several matching regular happy hours can appear in one message.

## Explicit followed-venue Live Deal

This is much more time-sensitive.

Architecture should allow a promotion launch to trigger prompt notification to followers rather than waiting a long time.

The existing 15-minute job may remain initially if changing scheduling would create excessive scope, but design the event model so promotion-created notifications can later dispatch immediately.

Do not make the data model depend on polling forever.

---

# 37. Notification Caps

Be careful applying global SMS caps to explicitly requested followed-venue promotions.

Do not remove cost controls now.

But separate:

> broad discovery alerts

from:

> explicit venue-follow alerts

in the model so they can have different policies later.

The user who explicitly said:

> “Tell me whenever Craft & Commerce launches a special”

has a stronger notification expectation than someone with a broad:

> “North Park cocktails”

saved search.

---

# 38. Consumer Alert UI Simplification

The consumer should not need to understand internal campaign mechanics.

Use language like:

# What would you like alerts about?

### Happy Hours

> Regular scheduled happy hours from places and searches you follow.

### Special Deals

> Limited-time offers and Live Deals launched by venues.

That's it initially.

Do not expose:

* boost
* campaign status
* paid promotion
* promotion distribution
* merchant quota

to consumers.

---

# 39. Default Alert Behavior

For existing alerts created before this migration, preserve current behavior rather than silently disabling notifications.

Recommended migration behavior:

Existing saved alerts:

> `happy_hour = true`

because that is what users originally signed up for.

For:

> `promotion = ?`

Choose deliberately.

Recommended conservative choice:

> `promotion = false`

for existing alerts unless existing copy clearly promised all future merchant Live promotions.

Then invite users to enable:

> **Special Deals**

This avoids silently broadening the type of promotional communication users receive.

New alerts can clearly present both choices during creation.

---

# 40. Venue Follow Defaults

When a user explicitly taps a new:

> **Follow**

control on a venue, keep setup simple.

Suggested modal:

# Follow Craft & Commerce

Notify me about:

> ☑ Special Deals

> ☐ Regular Happy Hour reminders

Why default Special Deals on?

Because following the restaurant is likely to mean:

> tell me when something new happens.

However, if existing product research suggests regular happy-hour alerts are the primary expectation, default both and make the choices obvious before confirmation.

Do not enable SMS silently.

Channel consent remains separate.

---

# 41. Terminology

Use consistent language everywhere.

## Consumer

**Happy Hour Now**
= normal schedule currently active

**Live Deal**
= special temporary merchant promotion currently active

**Special Deals**
= consumer alert category covering merchant-created promotions

## Merchant

**Promotion**
= campaign object

**Go Live**
= start promotion now

**Schedule**
= start later

**Boost**
= future paid incremental reach

Avoid using `Live` by itself to describe ordinary recurring happy hour.

---

# 42. Migration / Backward Compatibility

Existing data currently represented by:

* `live_overrides`
* venue-keyed `promotions`

must not simply disappear.

Create a migration strategy.

For existing saved promotions:

* convert them into draft promotions if timing is unknown, or
* preserve them in legacy storage while requiring merchants to recreate/launch under the new model.

Do not invent start/end times.

For active `live_overrides` during deployment:

* either let them expire naturally,
* or migrate carefully into short-lived promotions only if the associated promotion has enough information to create a legitimate offer.

Document the decision.

---

# 43. Important Security Rules

Continue enforcing:

* merchant must be signed in
* merchant must hold verified claim for venue
* merchant can only mutate its own claimed venue promotions
* deal codes must not accidentally leak through public API if they are intended to be gated
* public endpoints return only public fields
* promotion times and fields are validated server-side
* end time must be later than start time
* maximum reasonable promotion duration should be enforced

Do not rely on UI hiding for authorization.

---

# 44. Validation Rules

Promotion:

* headline required
* headline short enough for notifications/cards
* end required before launch/scheduling
* end > start
* description optional or bounded
* deal code optional and bounded
* type must come from supported enum
* no indefinite promotions
* cancelled promotions cannot become Live without explicit reactivation logic

Sanitize all free text consistently with existing project conventions.

---

# 45. Accessibility

All new controls must:

* work with keyboard navigation
* have visible focus states
* use semantic buttons/forms
* include accessible labels
* not rely solely on green/red color to communicate state
* respect reduced-motion preference for countdown/attention effects
* use `aria-live` for launch/save result messaging where appropriate

---

# 46. Mobile

Merchant dashboard must remain usable on mobile because restaurant managers are likely to launch promotions from phones.

Prioritize:

* large Go Live action
* concise promotion form
* easy end-time selection
* no wide desktop-only tables
* active promotion clearly visible above the fold

A manager should be able to launch:

> $5 Margaritas Until 7 PM

in well under one minute.

---

# 47. Tests

Add unit/integration coverage for at least:

### Happy Hour State

* before start
* exactly at start
* during
* exactly at end
* different days
* Pacific timezone / DST edge where practical

### Promotion State

* draft
* future scheduled
* exact start
* live
* exact end
* ended
* cancelled

### Combined Venue State

* neither active
* happy hour only
* promotion only
* both

### Alert Matching

* HH-only user receives normal HH alert, not promo
* promo-only user receives promo, not HH
* both receives both
* followed venue respects independent toggles
* saved search respects `alertKinds`
* promotion dedup uses promotion ID
* separate promotions from same venue can each notify
* same promotion cannot repeatedly notify during polling
* same recurring HH occurrence cannot repeatedly notify

### Merchant Authorization

* unclaimed venue forbidden
* pending claim forbidden
* verified claimed venue allowed

### Promotion Validation

* invalid end before start rejected
* missing headline rejected
* unsupported type rejected

---

# 48. Update Documentation

Update `README-NOTIFICATIONS-SETUP.md`.

Remove language that says:

> either normal schedule or manual override makes a venue “live.”

Document the new distinction:

> normal happy-hour schedule → Happy Hour Now

> merchant promotion → Live Deal

Document the two alert families.

Document promotion notification behavior.

Document deprecated `live_overrides` behavior if temporarily retained.

---

# 49. Recommended Build Order

Do not try to change everything simultaneously.

Implement in this order:

## Phase 1 — Model

1. Shared time/status logic
2. Promotion migration/schema
3. promotion repository/store functions
4. promotion state helper
5. API redesign

## Phase 2 — Merchant

6. replace Live toggle
7. create Launch Promotion flow
8. create Schedule Promotion flow
9. Active/Scheduled/Past sections
10. entitlement placeholder

## Phase 3 — Consumer Presentation

11. Happy Hour Now badge
12. Live Deal badge
13. homepage card hierarchy
14. Live Deals page
15. venue detail promotion block

## Phase 4 — Alerts

16. notification event identity
17. two alert families
18. follow preferences
19. saved-alert `alertKinds`
20. HH dispatch
21. promotion dispatch
22. dedup redesign

## Phase 5 — Cleanup

23. remove/deprecate old live override calls
24. remove obsolete UI
25. update docs
26. add/finish tests
27. run full regression

Commit in logical stages rather than one giant commit.

---

# 50. Acceptance Criteria

The redesign is complete when all of the following are true:

* A normal scheduled happy hour automatically displays **Happy Hour Now**.
* The merchant does not manually toggle ordinary happy hour Live.
* A merchant can create a special promotion.
* A merchant can launch it immediately.
* A merchant can schedule it.
* A promotion automatically becomes Live based on its time.
* A promotion automatically ends.
* Multiple historical promotions can exist for one venue.
* A venue can have a regular happy hour and Live Deal simultaneously.
* Live Deal visually outranks Happy Hour Now.
* A dedicated Live Deals page surfaces active promotions without duplicating full promotion cards on the homepage.
* Permanent happy-hour deals remain separate from promotional offers.
* Deal codes are optional.
* Consumers can independently opt into:

  * regular Happy Hour Alerts
  * Special Deal Alerts
* Saved search alerts can listen for either or both.
* A followed venue can have independent Happy Hour and Special Deal notification settings.
* Notification dedup distinguishes different promotions at the same venue.
* Existing happy-hour alert behavior is preserved.
* No payment processing is required to exercise the new promotion workflow.
* Promotion entitlement logic is centralized for future free/Pro/paid campaign rules.
* Existing unrelated listing/photo/menu behavior continues to work.

---

# 51. Product Principle to Preserve

Use this as the design rule whenever there is ambiguity:

> **Regular Happy Hour = inventory.**

> **Promotion = marketing.**

> **Live = urgency.**

> **Boost = distribution.**

And for users:

> **Happy Hour Alerts = tell me when the normal deals I care about are happening.**

> **Special Deal Alerts = tell me when something exceptional has been launched.**

The architecture, UI, database, and notification code should reinforce those distinctions rather than collapsing them back together.
