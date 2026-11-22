// The webhook payload for one regression. Pure.
import { createHash } from "node:crypto";
import { LOG_DERIVED } from "../reporting/report-schema.js";
import type { ReportRegression } from "../reporting/report-types.js";
import { REGRESSION_DETECTED_EVENT, WEBHOOK_SCHEMA_VERSION, type WebhookPayload } from "./webhook-payload-schema.js";

const EVENT_ID_LENGTH = 16;

// The same regression always gets the same id (no clock, no randomness), so
// a receiver can de-duplicate even if it ever sees an event twice.
export function makeEventId(service: string, deploySha: string, fingerprint: string): string {
  return createHash("sha256").update(JSON.stringify([service, deploySha, fingerprint])).digest("hex").slice(0, EVENT_ID_LENGTH);
}

export function buildWebhookPayload(service: string, regression: ReportRegression): WebhookPayload {
  const topSuspect = regression.suspects[0];
  return {
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
    event: REGRESSION_DETECTED_EVENT,
    eventId: makeEventId(service, regression.deploySha, regression.fingerprint),
    service,
    deploySha: regression.deploySha,
    fingerprint: regression.fingerprint,
    firstSeen: regression.firstSeen,
    occurrences: regression.occurrences,
    severity: regression.severity,
    suspect:
      topSuspect === undefined
        ? null
        : { commitSha: topSuspect.commitSha, prNumber: topSuspect.prNumber, confidence: topSuspect.confidence, authorName: topSuspect.author.name },
    label: LOG_DERIVED,
  };
}
