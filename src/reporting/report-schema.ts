// The report's JSON shape as zod schemas: the documented contract of
// `vika report --json` and GET /api/report (docs/report-schema.md). The
// TypeScript types in report-types.ts are made from these, so the code and
// the documented schema can never drift apart.
//
// REPORT_SCHEMA_VERSION changes only when a field is removed or its meaning
// changes. Adding a field does not change it.
import { z } from "zod";

export const REPORT_SCHEMA_VERSION = 1;

// Every number is derived from logs only (not from incident records), and says so.
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
  value: z.number().min(0).max(1).nullable(), // failed / judged; null when nothing was judged
  failedDeploys: z.number().int().min(0),
  judgedDeploys: z.number().int().min(0), // not starting points, not cold starts
  note: z.string().nullable(), // "not enough data" when value is null
});

export const medianTimeToRestoreSchema = z.strictObject({
  label: z.literal(LOG_DERIVED),
  valueMinutes: z.number().min(0).nullable(), // first seen -> restored, median over restored regressions
  restoredRegressions: z.number().int().min(0),
  note: z.string().nullable(),
});

export const ongoingRegressionsSchema = z.strictObject({
  label: z.literal(LOG_DERIVED),
  value: z.number().int().min(0), // regressions not restored by the end of the logs
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
  isFailed: z.boolean(), // at least one medium or high regression
});

export const reportRegressionSchema = z.strictObject({
  fingerprint: z.string(),
  kind: z.enum(["new", "spike"]),
  severity: z.enum(["high", "medium", "low"]),
  headline: z.string(), // one redacted line describing the error
  exceptionType: z.string().nullable(),
  deploySha: commitSha,
  deployTime: isoTimestamp.nullable(),
  firstSeen: isoTimestamp,
  occurrences: z.number().int().min(0),
  baselineRatePerHour: z.number().min(0),
  postDeployRatePerHour: z.number().min(0),
  isAmbiguous: z.boolean(), // another deploy happened shortly before this one
  restoredAt: isoTimestamp.nullable(), // null = still ongoing at the end of the logs
  suspects: z.array(suspectSchema), // strongest first, at most 3
  suspectMessage: z.string().nullable(), // why there are no suspects, when there are none
});

export const serviceReportSchema = z.strictObject({
  serviceName: z.string(),
  isSkipped: z.boolean(), // busy or failed this run; nothing below was computed
  notes: z.array(z.string()),
  logEntryCount: z.number().int().min(0), // error and warning lines stored
  errorGroupCount: z.number().int().min(0),
  deploys: z.array(reportDeploySchema),
  regressions: z.array(reportRegressionSchema),
  metrics: deliveryMetricsSchema,
});

export const reportSchema = z.strictObject({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  asOf: isoTimestamp.nullable(), // the latest log timestamp read, across all services
  services: z.array(serviceReportSchema),
  metrics: deliveryMetricsSchema, // all services rolled up
});
