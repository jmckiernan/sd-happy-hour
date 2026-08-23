-- Admin-granted promotion slots, scoped to one venue and one San Diego
-- calendar month. Every venue's plan allowance remains the base entitlement;
-- this table stores only the additional slots granted from the admin editor.

CREATE TABLE venue_promotion_allowances (
  venue_id               integer NOT NULL CHECK (venue_id > 0),
  month_key              text NOT NULL
                         CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  additional_allowance   integer NOT NULL DEFAULT 0
                         CHECK (additional_allowance >= 0),
  updated_by_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, month_key)
);

CREATE INDEX venue_promotion_allowances_month_idx
  ON venue_promotion_allowances (month_key, venue_id);

CREATE TRIGGER venue_promotion_allowances_updated_at
  BEFORE UPDATE ON venue_promotion_allowances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
