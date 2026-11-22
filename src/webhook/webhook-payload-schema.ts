// The `regression.detected` webhook payload as a zod schema: the documented
// contract (docs/report-schema.md). No raw log lines and no email addresses,
// ever: only the author's name.
//
// WEBHOOK_SCHEMA_VERSION changes only when a field is removed or its meaning
// changes. Adding a field does not change it.
import { z } from "zod";
import { LOG_DERIVED } from "../reporting/report-schema.js";

export const WEBHOOK_SCHEMA_VERSION = 1;
export const REGRESSION_DETECTED_EVENT = "regression.detected";

const commitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const webhookPayloadSchema = z.strictObject({
  schemaVersion: z.literal(WEBHOOK_SCHEMA_VERSION),
  event: z.literal(REGRESSION_DETECTED_EVENT),
  eventId: z.string().regex(/^[0-9a-f]{16}$/), // the same for the same regression, every time
  service: z.string(),
  deploySha: commitSha,
  fingerprint: z.string(), // the error group
  firstSeen: z.string().refine((text) => !Number.isNaN(Date.parse(text)), { error: "must be an ISO timestamp" }),
  occurrences: z.number().int().min(0), // since the deploy, when the event was sent
  severity: z.enum(["high", "medium", "low"]),
  suspect: z
    .strictObject({
      commitSha,
      prNumber: z.number().int().nullable(),
      confidence: z.enum(["high", "medium", "low"]),
      authorName: z.string(), // the name only; never the email
    })
    .nullable(), // null: no strong suspect in this deploy
  label: z.literal(LOG_DERIVED),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
