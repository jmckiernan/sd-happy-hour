-- Add pause control and last run tracking to the content engine settings.

ALTER TABLE content_engine_settings
  ADD COLUMN paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN content_engine_settings.paused IS
  'When true, scheduled runs are skipped entirely. Manual runs still work.';
