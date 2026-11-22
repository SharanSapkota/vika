-- 001_init: first schema for vika.
-- Every table has a service column. Raw log lines are never stored: only
-- redacted examples and per-minute counts.

-- Which migration files have been applied. (The runner also creates this
-- table before reading it, so IF NOT EXISTS here.)
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- One row per error group.
CREATE TABLE clusters (
  service            text        NOT NULL,
  fingerprint        text        NOT NULL,
  normalizer_version integer     NOT NULL,
  template           text        NOT NULL,
  exception_type     text,
  top_frames         jsonb       NOT NULL DEFAULT '[]',
  examples           jsonb       NOT NULL DEFAULT '[]', -- up to 3 redacted messages
  source_refs        jsonb       NOT NULL DEFAULT '[]', -- up to 3 "file:line"
  first_seen         timestamptz NOT NULL,
  last_seen          timestamptz NOT NULL,
  PRIMARY KEY (service, fingerprint)
);
CREATE INDEX clusters_service_first_seen ON clusters (service, first_seen);

-- How often each group happened, per minute.
CREATE TABLE cluster_counts (
  service     text        NOT NULL,
  fingerprint text        NOT NULL,
  minute      timestamptz NOT NULL,
  count       integer     NOT NULL CHECK (count >= 0),
  PRIMARY KEY (service, fingerprint, minute),
  FOREIGN KEY (service, fingerprint) REFERENCES clusters (service, fingerprint) ON DELETE CASCADE
);
-- For "which groups were seen in this time window" (the baseline).
CREATE INDEX cluster_counts_service_minute ON cluster_counts (service, minute);

-- Where we stopped reading each log source.
-- Files use byte_offset + inode; commands use last_timestamp.
CREATE TABLE bookmarks (
  service        text NOT NULL,
  source_key     text NOT NULL,
  byte_offset    bigint,
  inode          text,
  last_timestamp timestamptz,
  PRIMARY KEY (service, source_key)
);

-- The template miner's saved state (plain JSON), one per service.
CREATE TABLE miner_state (
  service text PRIMARY KEY,
  state   jsonb NOT NULL
);

-- Deploy timeline.
CREATE TABLE deploys (
  service      text        NOT NULL,
  sha          text        NOT NULL,
  previous_sha text,
  time         timestamptz NOT NULL,
  source       text        NOT NULL,
  UNIQUE (service, sha, time)
);
CREATE INDEX deploys_service_time ON deploys (service, time);
