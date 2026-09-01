-- How a person suggesting a listing correction knows the venue or the
-- information they submitted. Existing submissions predate this prompt, so
-- they remain valid with an empty value.

ALTER TABLE submissions
  ADD COLUMN contact_relationship text NOT NULL DEFAULT '';
