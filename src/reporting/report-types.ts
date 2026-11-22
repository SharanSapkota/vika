// The report object: what `vika report` prints as text, and as-is with --json.
// The types come from the zod schemas in report-schema.ts (the documented
// contract), so they can't drift apart. See docs/report-schema.md.
import type { z } from "zod";
import type {
  changeFailureRateSchema,
  deliveryMetricsSchema,
  medianTimeToRestoreSchema,
  ongoingRegressionsSchema,
  reportDeploySchema,
  reportRegressionSchema,
  reportSchema,
  serviceReportSchema,
} from "./report-schema.js";

export { LOG_DERIVED, NOT_ENOUGH_DATA, REPORT_SCHEMA_VERSION } from "./report-schema.js";

export type ChangeFailureRate = z.infer<typeof changeFailureRateSchema>;
export type MedianTimeToRestore = z.infer<typeof medianTimeToRestoreSchema>;
export type OngoingRegressions = z.infer<typeof ongoingRegressionsSchema>;
export type DeliveryMetrics = z.infer<typeof deliveryMetricsSchema>;
export type ReportDeploy = z.infer<typeof reportDeploySchema>;
export type ReportRegression = z.infer<typeof reportRegressionSchema>;
export type ServiceReport = z.infer<typeof serviceReportSchema>;
export type Report = z.infer<typeof reportSchema>;
