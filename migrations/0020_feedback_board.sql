-- Stored product feedback and a one-upvote-per-account feature board.

CREATE TABLE bug_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  email            text NOT NULL DEFAULT '',
  title            text NOT NULL,
  details          text NOT NULL,
  page_url         text NOT NULL DEFAULT '',
  user_agent       text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'closed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bug_reports_status_created_idx ON bug_reports (status, created_at DESC);
CREATE TRIGGER bug_reports_updated_at BEFORE UPDATE ON bug_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE feature_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_kind    text NOT NULL CHECK (author_kind IN ('user', 'venue_owner')),
  title          text NOT NULL,
  details        text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'planned', 'complete', 'closed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feature_requests_status_created_idx ON feature_requests (status, created_at DESC);
CREATE TRIGGER feature_requests_updated_at BEFORE UPDATE ON feature_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE feature_request_votes (
  feature_request_id uuid NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_request_id, user_id)
);

CREATE INDEX feature_request_votes_user_idx ON feature_request_votes (user_id);
