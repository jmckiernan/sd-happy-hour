-- Scraped happy-hour menus, as structured rows.
--
-- Why not `menu_sections` / `menu_items` (0004): those are the *owner's* full
-- menu — hand-authored, editable in the claim dashboard, with dish photos and
-- moderation. These rows are machine-extracted happy-hour offers with
-- provenance, rewritten wholesale on every scrape. Sharing tables would mean
-- a re-scrape silently deleting an owner's work, and an owner's edit
-- corrupting the analysis corpus.
--
-- Why the database at all, when the pipeline already stores `hhMenu` in
-- public/data/happy-hours.json: that file is a per-venue document, so
-- "cocktails under $8 in North Park" or "how did wing prices move this year"
-- means loading 611 nested documents and walking them in JS. Here it's one
-- indexed query. The JSON stays the source of truth that renders the site and
-- the menu boards; this is the queryable projection of it, rebuilt by
-- `npm run menus:sync`.

-- ---------------------------------------------------------------------------
-- One row per venue that publishes a happy-hour menu
-- ---------------------------------------------------------------------------
CREATE TABLE happy_hour_menus (
  -- Not a foreign key: venues live in happy-hours.json, not in this database.
  -- Same reasoning as venue_overrides/promotions/live_overrides.
  venue_id      integer PRIMARY KEY,
  -- Denormalized so analysis queries don't need the JSON file to say where an
  -- item was sold. Kept in sync by the same script that writes the items.
  venue_name    text NOT NULL DEFAULT '',
  neighborhood  text NOT NULL DEFAULT '',
  -- Board note ("Dine-in only", "bar area only") — a real constraint on every
  -- price below it, so it belongs with the menu rather than on each item.
  note          text NOT NULL DEFAULT '',
  -- The happy-hour schedule as stored on the listing (`windows[]`). JSONB
  -- rather than columns because a venue can have several windows with
  -- different days, and the shape follows the Listing type.
  windows       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Where the menu was read from, and when — required to judge staleness and
  -- to re-check a suspicious extraction.
  source_url    text NOT NULL DEFAULT '',
  scraped_at    timestamptz,
  item_count    integer NOT NULL DEFAULT 0,
  synced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX happy_hour_menus_neighborhood_idx ON happy_hour_menus (neighborhood);

-- ---------------------------------------------------------------------------
-- One row per offer
-- ---------------------------------------------------------------------------
CREATE TABLE happy_hour_menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id      integer NOT NULL REFERENCES happy_hour_menus (venue_id) ON DELETE CASCADE,
  -- The venue's own heading ("Bites", "Drinks", "Half Off Apps & Pizzas").
  -- Not normalized to a fixed vocabulary: the raw heading is evidence, and
  -- `category` below carries the comparable version.
  section_title text NOT NULL DEFAULT '',
  name          text NOT NULL,
  -- Verbatim, the way menu_items.price is: real menus say "$8", "6/9",
  -- "½ off", "market price".
  price_text    text NOT NULL DEFAULT '',
  -- The comparable numbers, null when the offer has no single price. Split
  -- from price_text so "cocktails under $8" and "half off" are both
  -- answerable without parsing strings at query time.
  --   fixed      — "$8"           → price_amount 8
  --   amount_off — "$2 off"       → discount_amount 2
  --   percent_off— "20% off"      → discount_percent 20
  --   half_off   — "½ off"        → discount_percent 50
  --   range      — "6/9", "$6–$9" → price_amount 6, price_amount_max 9
  --   other      — "market price", "varies", or unparseable
  price_kind    text NOT NULL DEFAULT 'other'
                CHECK (price_kind IN ('fixed', 'amount_off', 'percent_off', 'half_off', 'range', 'other')),
  price_amount      numeric(8,2),
  price_amount_max  numeric(8,2),
  discount_amount   numeric(8,2),
  discount_percent  numeric(5,2),
  -- Coarse, comparable bucket derived from the item and section names, so
  -- cross-venue questions ("cheapest draft beer at 5pm") don't depend on each
  -- venue's wording. Deliberately short: food/drink splits that a reader
  -- would agree with, not a cuisine taxonomy.
  category      text NOT NULL DEFAULT 'other'
                CHECK (category IN ('beer', 'wine', 'cocktail', 'spirit', 'na_beverage',
                                    'food', 'oysters', 'other')),
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX happy_hour_menu_items_venue_idx ON happy_hour_menu_items (venue_id, sort_order);
-- "What's the cheapest X" / "everything under $Y in category Z".
CREATE INDEX happy_hour_menu_items_category_price_idx
  ON happy_hour_menu_items (category, price_amount)
  WHERE price_amount IS NOT NULL;

-- Free-text search over the offer, including the venue's own heading, since
-- that's often where the useful word lives ("Oyster Hour", "Taco Tuesday").
ALTER TABLE happy_hour_menu_items
  ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name, '') || ' ' || coalesce(section_title, ''))
  ) STORED;

CREATE INDEX happy_hour_menu_items_search_idx ON happy_hour_menu_items USING GIN (search);
