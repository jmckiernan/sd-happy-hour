-- Reserve event alert preference on venue follows so Audience can count
-- event subscribers when Events ships. Default off; no Events product yet.

ALTER TABLE venue_follows
  ADD COLUMN IF NOT EXISTS event_alerts_enabled boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS venue_follows_event_idx
  ON venue_follows (venue_id)
  WHERE event_alerts_enabled;
