import { z } from "zod";

export const REPORT_SCHEMA_VERSION = 1;

export const LOG_DERIVED = "log-derived";
export const NOT_ENOUGH_DATA = "not enough data";

const isoTimestamp = z.string().refine((text) => !Number.isNaN(Date.parse(text)), { error: "must be an ISO timestamp" });
const commitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const suspectSchema = z.strictObject({
  commitSha,
  prNumber: z.number().int().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceKind: z.enum([
    "blamed-line-changed",
    "same-function-changed",
    "call-chain-function-changed",
    "file-changed",
    "dependency-or-config-change",
    "timing-only",
  ]),
  reason: z.string(),
  filePath: z.string(),
  lineNumber: z.number().int().nullable(),
  lineText: z.string().nullable(),
  author: z.strictObject({ name: z.string(), email: z.string() }),
  isInDeployRange: z.literal(true),
  isBot: z.boolean(),
});

export const changeFailureRateSchema = z.strictObject({
  label: z.literal(LOG_DERIVED),
  value: z.number().min(0).max(1).nullable(),
  failedDeploys: z.number().int().min(0),
  judgedDeploys: z.number().int().min(0),
  note: z.string().nullable(),
});

export const medianTimeToRestoreSchema = z.strictObject({
  label: z.literal(LOG_DERIVED),
  valueMinutes: z.number().min(0).nullable(),
  restoredRegressions: z.number().int().min(0),
  note: z.string().nullable(),
});

export const ongoingRegressionsSchema = z.strictObject({
  label: z.literal(LOG_DERIVED),
  value: z.number().int().min(0),
});

export const deliveryMetricsSchema = z.strictObject({
  changeFailureRate: changeFailureRateSchema,
  medianTimeToRestore: medianTimeToRestoreSchema,
  ongoingRegressions: ongoingRegressionsSchema,
});

export const reportDeploySchema = z.strictObject({
  deploySha: commitSha,
  time: isoTimestamp,
  status: z.enum(["checked", "insufficient_baseline", "starting_point"]),
  isFailed: z.boolean(),
});

// The optional AI opinion from `vika report --explain`. Never part of the
// ranking: the suspects list above it is exactly what vika's rules chose.
export const explanationSchema = z.strictObject({
  model: z.string(),
  answerText: z.string(),
});

export const reportRegressionSchema = z.strictObject({
  fingerprint: z.string(),
  kind: z.enum(["new", "spike"]),
  severity: z.enum(["high", "medium", "low"]),
  headline: z.string(),
  exceptionType: z.string().nullable(),
  deploySha: commitSha,
  deployTime: isoTimestamp.nullable(),
  firstSeen: isoTimestamp,
  occurrences: z.number().int().min(0),
  baselineRatePerHour: z.number().min(0),
  postDeployRatePerHour: z.number().min(0),
  isAmbiguous: z.boolean(),
  restoredAt: isoTimestamp.nullable(),
  suspects: z.array(suspectSchema),
  suspectMessage: z.string().nullable(),
  // Present only when --explain ran: the answer, or null when nothing was
  // sent or the request failed. Absent otherwise.
  explanation: explanationSchema.nullable().optional(),
});

export const serviceReportSchema = z.strictObject({
  serviceName: z.string(),
  isSkipped: z.boolean(),
  notes: z.array(z.string()),
  logEntryCount: z.number().int().min(0),
  errorGroupCount: z.number().int().min(0),
  deploys: z.array(reportDeploySchema),
  regressions: z.array(reportRegressionSchema),
  metrics: deliveryMetricsSchema,
});

export const reportSchema = z.strictObject({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  asOf: isoTimestamp.nullable(),
  services: z.array(serviceReportSchema),
  metrics: deliveryMetricsSchema,
});
