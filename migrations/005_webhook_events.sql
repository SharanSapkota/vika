-- 005_webhook_events: which regressions `vika run` has posted to the webhook,
-- so the same regression is never delivered twice.
--
-- One row per regression: service + deploy sha + error group fingerprint.
-- The row is written (ON CONFLICT DO NOTHING) before the first attempt. A
-- failed delivery stays "failed" and is tried once more on each later run
-- (never in a loop) until it is "delivered"; after that it is never sent again.
CREATE TABLE webhook_events (
  service     text        NOT NULL,
  deploy_sha  text        NOT NULL,
  fingerprint text        NOT NULL,
  event_id    text        NOT NULL, -- the eventId in the payload, stable for this regression
  status      text        NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts    integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service, deploy_sha, fingerprint)
);
