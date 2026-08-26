-- Always-current San Diego content engine.
-- Discovery and review state lives in Postgres; approved blog posts still
-- publish through the existing GitHub-backed Markdown content collection.

CREATE TABLE content_sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (btrim(name) <> ''),
  kind                text NOT NULL CHECK (kind IN (
                        'rss', 'atom', 'google_alert', 'reddit_rss',
                        'json_ld', 'webhook'
                      )),
  url                 text NOT NULL CHECK (btrim(url) <> ''),
  enabled             boolean NOT NULL DEFAULT true,
  trust_score         numeric(4,3) NOT NULL DEFAULT 0.600
                        CHECK (trust_score BETWEEN 0 AND 1),
  county_scoped       boolean NOT NULL DEFAULT false,
  image_policy        text NOT NULL DEFAULT 'none'
                        CHECK (image_policy IN ('none', 'first_party', 'attributed')),
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  etag                text,
  last_modified       text,
  last_fetched_at     timestamptz,
  last_success_at     timestamptz,
  last_error          text,
  consecutive_errors  integer NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (url)
);

CREATE INDEX content_sources_enabled_idx ON content_sources (enabled, name);
CREATE TRIGGER content_sources_updated_at BEFORE UPDATE ON content_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE content_ingestion_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type         text NOT NULL CHECK (trigger_type IN ('scheduled', 'manual', 'event')),
  status               text NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  sources_attempted    integer NOT NULL DEFAULT 0 CHECK (sources_attempted >= 0),
  sources_succeeded    integer NOT NULL DEFAULT 0 CHECK (sources_succeeded >= 0),
  items_fetched        integer NOT NULL DEFAULT 0 CHECK (items_fetched >= 0),
  items_created        integer NOT NULL DEFAULT 0 CHECK (items_created >= 0),
  items_merged         integer NOT NULL DEFAULT 0 CHECK (items_merged >= 0),
  items_outside_county integer NOT NULL DEFAULT 0 CHECK (items_outside_county >= 0),
  clusters_created     integer NOT NULL DEFAULT 0 CHECK (clusters_created >= 0),
  drafts_created       integer NOT NULL DEFAULT 0 CHECK (drafts_created >= 0),
  errors               jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz
);

CREATE INDEX content_ingestion_runs_started_idx
  ON content_ingestion_runs (started_at DESC);

CREATE TABLE content_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key      text NOT NULL UNIQUE,
  venue_name         text,
  title              text NOT NULL CHECK (btrim(title) <> ''),
  description        text NOT NULL DEFAULT '',
  event_start_at     timestamptz,
  event_end_at       timestamptz,
  all_day            boolean NOT NULL DEFAULT false,
  neighborhood       text,
  area               text,
  address            text,
  county             text NOT NULL DEFAULT 'San Diego',
  confidence_score   numeric(4,3) NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
  status             text NOT NULL DEFAULT 'candidate'
                       CHECK (status IN ('candidate', 'review', 'accepted', 'rejected', 'expired')),
  event_types        jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags               jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls         jsonb NOT NULL DEFAULT '[]'::jsonb,
  quality_flags      jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_items_event_order CHECK (
    event_end_at IS NULL OR event_start_at IS NULL OR event_end_at >= event_start_at
  )
);

CREATE INDEX content_items_status_event_idx
  ON content_items (status, event_start_at, confidence_score DESC);
CREATE INDEX content_items_last_seen_idx ON content_items (last_seen_at DESC);
CREATE INDEX content_items_event_types_gin ON content_items USING gin (event_types);
CREATE INDEX content_items_tags_gin ON content_items USING gin (tags);
CREATE TRIGGER content_items_updated_at BEFORE UPDATE ON content_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE content_item_sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  source_id           uuid REFERENCES content_sources(id) ON DELETE SET NULL,
  external_id         text,
  source_url          text NOT NULL CHECK (btrim(source_url) <> ''),
  source_title        text NOT NULL DEFAULT '',
  source_description  text NOT NULL DEFAULT '',
  source_published_at timestamptz,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  image_urls          jsonb NOT NULL DEFAULT '[]'::jsonb,
  attribution         text,
  raw_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (item_id, source_url)
);

CREATE INDEX content_item_sources_item_idx
  ON content_item_sources (item_id, fetched_at DESC);
CREATE INDEX content_item_sources_source_idx
  ON content_item_sources (source_id, fetched_at DESC);
CREATE INDEX content_item_sources_url_idx ON content_item_sources (source_url);

CREATE TABLE content_clusters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  angle              text NOT NULL CHECK (btrim(angle) <> ''),
  working_title      text NOT NULL CHECK (btrim(working_title) <> ''),
  summary            text NOT NULL DEFAULT '',
  cluster_type       text NOT NULL CHECK (cluster_type IN (
                       'single', 'date_roundup', 'weekend_roundup',
                       'neighborhood_roundup', 'event_type_roundup', 'evergreen'
                     )),
  status             text NOT NULL DEFAULT 'candidate'
                       CHECK (status IN ('candidate', 'drafted', 'rejected', 'archived')),
  editorial_score    numeric(4,3) NOT NULL CHECK (editorial_score BETWEEN 0 AND 1),
  confidence_score   numeric(4,3) NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
  event_start_at     timestamptz,
  event_end_at       timestamptz,
  tags               jsonb NOT NULL DEFAULT '[]'::jsonb,
  signature          text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX content_clusters_status_created_idx
  ON content_clusters (status, created_at DESC);
CREATE TRIGGER content_clusters_updated_at BEFORE UPDATE ON content_clusters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE content_cluster_items (
  cluster_id uuid NOT NULL REFERENCES content_clusters(id) ON DELETE CASCADE,
  item_id    uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'supporting'
               CHECK (role IN ('lead', 'supporting', 'context')),
  position   integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (cluster_id, item_id)
);

CREATE INDEX content_cluster_items_item_idx
  ON content_cluster_items (item_id, cluster_id);

CREATE TABLE content_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id         uuid NOT NULL REFERENCES content_clusters(id) ON DELETE CASCADE,
  content_type       text NOT NULL CHECK (content_type IN ('blog', 'newsletter')),
  status             text NOT NULL DEFAULT 'review'
                       CHECK (status IN (
                         'generating', 'review', 'approved', 'rejected',
                         'scheduled', 'published', 'error'
                       )),
  title              text NOT NULL CHECK (btrim(title) <> ''),
  slug               text,
  description        text NOT NULL DEFAULT '',
  body_markdown      text NOT NULL DEFAULT '',
  seo_metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  structured_blocks  jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags               jsonb NOT NULL DEFAULT '[]'::jsonb,
  dates              jsonb NOT NULL DEFAULT '[]'::jsonb,
  locations          jsonb NOT NULL DEFAULT '[]'::jsonb,
  brands             jsonb NOT NULL DEFAULT '[]'::jsonb,
  event_types        jsonb NOT NULL DEFAULT '[]'::jsonb,
  hero_image_url     text,
  image_metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  quality_score      numeric(4,3) NOT NULL DEFAULT 0 CHECK (quality_score BETWEEN 0 AND 1),
  quality_flags      jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_for      timestamptz,
  approved_at        timestamptz,
  published_at       timestamptz,
  github_path        text,
  generation_version integer NOT NULL DEFAULT 1 CHECK (generation_version > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster_id, content_type)
);

CREATE UNIQUE INDEX content_drafts_slug_key ON content_drafts (slug)
  WHERE slug IS NOT NULL AND content_type = 'blog';
CREATE INDEX content_drafts_review_idx
  ON content_drafts (status, content_type, created_at DESC);
CREATE INDEX content_drafts_schedule_idx
  ON content_drafts (scheduled_for)
  WHERE status = 'scheduled';
CREATE TRIGGER content_drafts_updated_at BEFORE UPDATE ON content_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE content_engine_settings (
  singleton                boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  auto_publish_enabled     boolean NOT NULL DEFAULT false,
  auto_publish_min_quality numeric(4,3) NOT NULL DEFAULT 0.900
                             CHECK (auto_publish_min_quality BETWEEN 0 AND 1),
  min_item_confidence      numeric(4,3) NOT NULL DEFAULT 0.550
                             CHECK (min_item_confidence BETWEEN 0 AND 1),
  min_cluster_score        numeric(4,3) NOT NULL DEFAULT 0.620
                             CHECK (min_cluster_score BETWEEN 0 AND 1),
  require_multiple_sources boolean NOT NULL DEFAULT true,
  generate_images          boolean NOT NULL DEFAULT true,
  run_schedule             text NOT NULL DEFAULT 'twice_daily',
  updated_at               timestamptz NOT NULL DEFAULT now()
);

INSERT INTO content_engine_settings (singleton) VALUES (true);

CREATE TRIGGER content_engine_settings_updated_at
  BEFORE UPDATE ON content_engine_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE content_engine_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name  text NOT NULL CHECK (event_name IN (
                'source_fetched', 'item_created', 'item_merged', 'item_rejected',
                'cluster_created', 'draft_created', 'draft_approved', 'draft_rejected',
                'post_scheduled', 'post_published', 'newsletter_created',
                'image_attached', 'image_generated', 'image_failed',
                'article_view', 'article_link_click'
              )),
  source_id   uuid REFERENCES content_sources(id) ON DELETE SET NULL,
  item_id     uuid REFERENCES content_items(id) ON DELETE SET NULL,
  cluster_id  uuid REFERENCES content_clusters(id) ON DELETE SET NULL,
  draft_id    uuid REFERENCES content_drafts(id) ON DELETE SET NULL,
  properties  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX content_engine_events_name_created_idx
  ON content_engine_events (event_name, created_at DESC);
CREATE INDEX content_engine_events_draft_created_idx
  ON content_engine_events (draft_id, created_at DESC)
  WHERE draft_id IS NOT NULL;

-- Publisher-provided or public semantic feeds. Reddit discoveries are kept
-- at low trust and require review/corroboration before any auto-publish gate.
INSERT INTO content_sources (
  name, kind, url, enabled, trust_score, county_scoped, image_policy, config
) VALUES
  (
    'San Diego Reader — Events', 'rss',
    'https://www.sandiegoreader.com/rss/events/', true, 0.780, true, 'none',
    '{"publisher":"San Diego Reader","includeKeywords":[]}'::jsonb
  ),
  (
    'r/SanDiegan — Things to do', 'reddit_rss',
    'https://www.reddit.com/r/SanDiegan/search.rss?q=%22things%20to%20do%22%20OR%20events%20OR%20music%20OR%20food&restrict_sr=1&sort=new',
    true, 0.520, true, 'none',
    '{"publisher":"Reddit r/SanDiegan","includeKeywords":["event","things to do","music","food","comedy","happy hour","weekend"]}'::jsonb
  ),
  (
    'r/sandiego — Events', 'reddit_rss',
    'https://www.reddit.com/r/sandiego/search.rss?q=events%20OR%20%22things%20to%20do%22%20OR%20concert%20OR%20comedy%20OR%20%22happy%20hour%22&restrict_sr=1&sort=new',
    true, 0.500, true, 'none',
    '{"publisher":"Reddit r/sandiego","includeKeywords":["event","things to do","concert","comedy","happy hour","live music"]}'::jsonb
  ),
  (
    'r/FoodSanDiego — Dining and deals', 'reddit_rss',
    'https://www.reddit.com/r/FoodSanDiego/search.rss?q=%22happy%20hour%22%20OR%20deal%20OR%20special%20OR%20opening%20OR%20event&restrict_sr=1&sort=new',
    true, 0.500, true, 'none',
    '{"publisher":"Reddit r/FoodSanDiego","includeKeywords":["happy hour","deal","special","opening","event","popup","pop-up"]}'::jsonb
  ),
  (
    'City of San Diego — Events', 'json_ld',
    'https://www.sandiego.gov/events/calendar', true, 0.900, true, 'first_party',
    '{"publisher":"City of San Diego","includeKeywords":[]}'::jsonb
  ),
  (
    'San Diego Theatres — Events', 'json_ld',
    'https://www.sandiegotheatres.org/events', true, 0.920, true, 'first_party',
    '{"publisher":"San Diego Theatres","includeKeywords":[]}'::jsonb
  )
ON CONFLICT (url) DO NOTHING;
