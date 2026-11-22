





import { z } from "zod";
import { LOG_DERIVED } from "../reporting/report-schema.js";

export const WEBHOOK_SCHEMA_VERSION = 1;
export const REGRESSION_DETECTED_EVENT = "regression.detected";

const commitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const webhookPayloadSchema = z.strictObject({
  schemaVersion: z.literal(WEBHOOK_SCHEMA_VERSION),
  event: z.literal(REGRESSION_DETECTED_EVENT),
  eventId: z.string().regex(/^[0-9a-f]{16}$/), 
  service: z.string(),
  deploySha: commitSha,
  fingerprint: z.string(), 
  firstSeen: z.string().refine((text) => !Number.isNaN(Date.parse(text)), { error: "must be an ISO timestamp" }),
  occurrences: z.number().int().min(0), 
  severity: z.enum(["high", "medium", "low"]),
  suspect: z
    .strictObject({
      commitSha,
      prNumber: z.number().int().nullable(),
      confidence: z.enum(["high", "medium", "low"]),
      authorName: z.string(), 
    })
    .nullable(), 
  label: z.literal(LOG_DERIVED),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
