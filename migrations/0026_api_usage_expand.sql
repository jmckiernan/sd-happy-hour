-- Expand API usage tracking to include non-AI services (email, SMS, Places API).

-- Add new providers
ALTER TABLE ai_usage_log 
  DROP CONSTRAINT ai_usage_log_provider_check,
  ADD CONSTRAINT ai_usage_log_provider_check 
    CHECK (provider IN ('anthropic', 'gemini', 'openai', 'google_places', 'resend', 'twilio'));

-- Add new features
ALTER TABLE ai_usage_log 
  DROP CONSTRAINT ai_usage_log_feature_check,
  ADD CONSTRAINT ai_usage_log_feature_check 
    CHECK (feature IN (
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
    ));

-- Add message_count column for email/SMS tracking
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS message_count integer CHECK (message_count >= 0);

COMMENT ON COLUMN ai_usage_log.message_count IS
  'Number of messages sent (for email/SMS tracking)';
