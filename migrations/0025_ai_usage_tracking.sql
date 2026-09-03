-- Centralized API usage and cost tracking across all integrations.
-- Tracks every API call with token counts, costs, and context.

CREATE TABLE ai_usage_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Which provider and model/service
  provider            text NOT NULL CHECK (provider IN ('anthropic', 'gemini', 'openai', 'google_places', 'resend', 'twilio')),
  model               text NOT NULL,
  
  -- What feature/context triggered this call
  feature             text NOT NULL CHECK (feature IN (
                        'content_engine_draft',
                        'content_engine_newsletter', 
                        'content_engine_cluster_refinement',
                        'content_engine_image',
                        'manual_draft_generation',
                        'admin_image_generation',
                        'admin_image_edit',
                        'photo_moderation',
                        'email_alert',
                        'sms_alert',
                        'venue_import',
                        'other'
                      )),
  
  -- Optional references to related entities
  content_run_id      uuid REFERENCES content_ingestion_runs(id) ON DELETE SET NULL,
  draft_id            uuid REFERENCES content_drafts(id) ON DELETE SET NULL,
  
  -- Token usage (for text models)
  input_tokens        integer CHECK (input_tokens >= 0),
  output_tokens       integer CHECK (output_tokens >= 0),
  
  -- For image models, track image count instead
  image_count         integer CHECK (image_count >= 0),
  
  -- Cost in USD cents (to avoid floating point issues)
  -- Calculated based on current pricing at time of call
  cost_cents          numeric(10,4) NOT NULL DEFAULT 0,
  
  -- Request metadata
  request_metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  
  -- Whether the call succeeded
  success             boolean NOT NULL DEFAULT true,
  error_message       text,
  
  -- Timing
  duration_ms         integer CHECK (duration_ms >= 0),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_usage_log_provider_created_idx ON ai_usage_log (provider, created_at DESC);
CREATE INDEX ai_usage_log_feature_created_idx ON ai_usage_log (feature, created_at DESC);
CREATE INDEX ai_usage_log_created_idx ON ai_usage_log (created_at DESC);
CREATE INDEX ai_usage_log_content_run_idx ON ai_usage_log (content_run_id) WHERE content_run_id IS NOT NULL;

-- Materialized view for daily cost summaries (refresh periodically)
CREATE MATERIALIZED VIEW ai_usage_daily_summary AS
SELECT
  date_trunc('day', created_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
  provider,
  model,
  feature,
  count(*) AS call_count,
  sum(input_tokens) AS total_input_tokens,
  sum(output_tokens) AS total_output_tokens,
  sum(image_count) AS total_images,
  sum(cost_cents) AS total_cost_cents,
  sum(CASE WHEN success THEN 1 ELSE 0 END) AS success_count,
  sum(CASE WHEN NOT success THEN 1 ELSE 0 END) AS error_count
FROM ai_usage_log
GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX ai_usage_daily_summary_idx 
  ON ai_usage_daily_summary (day, provider, model, feature);

-- Add costs tracking to content_ingestion_runs for per-run cost summaries
ALTER TABLE content_ingestion_runs
  ADD COLUMN costs jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN content_ingestion_runs.costs IS
  'AI cost breakdown for this run in USD cents: { content_generation, cluster_refinement, image_generation, total }';
