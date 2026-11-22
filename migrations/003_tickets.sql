-- 003_tickets: tickets vika filed, so it never files the same one twice.
--
-- One row per bad deploy of a service: dedup_key is the deploy sha. A group
-- that shows up later on the same deploy is added to the existing ticket as
-- a comment, and its fingerprint is appended to `fingerprints`.
-- The primary key makes (service, dedup_key) unique, so two runs can't both
-- save a ticket for the same deploy (the second insert does nothing).
CREATE TABLE tickets (
  service          text        NOT NULL,
  dedup_key        text        NOT NULL,
  issue_key        text        NOT NULL, -- e.g. "OPS-123" (Jira) or "ENG-45" (Linear)
  issue_url        text        NOT NULL,
  tracker_type     text        NOT NULL, -- "jira" or "linear"
  deploy_sha       text        NOT NULL,
  fingerprints     jsonb       NOT NULL DEFAULT '[]', -- error groups the ticket covers
  last_known_count integer     NOT NULL CHECK (last_known_count >= 0), -- occurrences when last updated
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service, dedup_key)
);
