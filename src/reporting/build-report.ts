// Puts stored data, detector output and suspects together into one report
// object. Pure: no database, no git, no clock. The "as of" time is the
// latest log line read, so the same data always gives the same report.
import type { Deploy, StoredCluster } from "../database/store-types.js";
import type { DetectResult } from "../regression-detection/detection-types.js";
import type { AttributionResult } from "../suspect-attribution/suspect-types.js";
import { computeMetrics, rollUpMetrics, type MetricsInput } from "./compute-metrics.js";
import { REPORT_SCHEMA_VERSION, type Report, type ReportRegression, type ServiceReport } from "./report-types.js";

const HEADLINE_MAX_LENGTH = 160;

export interface ServiceReportInput {
  serviceName: string;
  isSkipped: boolean;
  notes: string[];
  clusters: StoredCluster[];
  countsByFingerprint: Record<string, Record<string, number>>;
  deploys: Deploy[];
  detection: DetectResult; // empty when skipped
  // One per detection.regressions entry, in the same order.
  attributions: AttributionResult[];
  lastLogTimestamp: string | null;
}

// One line that says what the error is: the line naming the exception if
// there is one ("TypeError: Cannot read ..."), else the first line. Taken
// from a stored example, which was redacted before it was stored.
function writeHeadline(cluster: StoredCluster | undefined): string {
  if (cluster === undefined) return "(unknown error group)";
  const exampleLines = (cluster.examples[0] ?? cluster.template).split("\n").map((line) => line.trim());
  const exceptionLine = cluster.exceptionType === undefined ? undefined : exampleLines.find((line) => line.startsWith(cluster.exceptionType!));
  const headline = exceptionLine ?? exampleLines[0] ?? "";
  return headline.length > HEADLINE_MAX_LENGTH ? `${headline.slice(0, HEADLINE_MAX_LENGTH - 3)}...` : headline;
}

function sumCounts(countsPerMinute: Record<string, number> | undefined): number {
  return Object.values(countsPerMinute ?? {}).reduce((total, count) => total + count, 0);
}

function buildServiceReport(input: ServiceReportInput): { serviceReport: ServiceReport; metricsInput: MetricsInput } {
  const clustersByFingerprint = new Map(input.clusters.map((cluster) => [cluster.fingerprint, cluster]));

  const deploys = input.detection.deploys.map((verdict) => ({
    deploySha: verdict.deploySha,
    time: verdict.time,
    status: verdict.status,
    isFailed: verdict.failed,
  }));

  const regressions: ReportRegression[] = input.detection.regressions.map((regression, regressionIndex) => {
    const cluster = clustersByFingerprint.get(regression.fingerprint);
    const attribution = input.attributions[regressionIndex] ?? { suspects: [], message: null };
    const deploy = input.deploys.find((candidate) => candidate.sha === regression.deploySha);
    return {
      fingerprint: regression.fingerprint,
      kind: regression.kind,
      severity: regression.severity,
      headline: writeHeadline(cluster),
      exceptionType: cluster?.exceptionType ?? null,
      deploySha: regression.deploySha,
      deployTime: deploy?.time ?? null,
      firstSeen: regression.firstSeen,
      occurrences: regression.occurrences,
      baselineRatePerHour: regression.baselineRate,
      postDeployRatePerHour: regression.postRate,
      isAmbiguous: regression.ambiguous,
      restoredAt: regression.restoredAt,
      suspects: attribution.suspects,
      suspectMessage: attribution.message,
    };
  });

  const metricsInput: MetricsInput = { deploys, regressions };
  return {
    serviceReport: {
      serviceName: input.serviceName,
      isSkipped: input.isSkipped,
      notes: input.notes,
      logEntryCount: input.clusters.reduce((total, cluster) => total + sumCounts(input.countsByFingerprint[cluster.fingerprint]), 0),
      errorGroupCount: input.clusters.length,
      deploys,
      regressions,
      metrics: computeMetrics(metricsInput),
    },
    metricsInput,
  };
}

export function buildReport(serviceInputs: ServiceReportInput[]): Report {
  const builtServices = serviceInputs.map(buildServiceReport);
  const lastLogTimestamps = serviceInputs
    .map((serviceInput) => serviceInput.lastLogTimestamp)
    .filter((timestamp): timestamp is string => timestamp !== null)
    .sort();
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    asOf: lastLogTimestamps.at(-1) ?? null,
    services: builtServices.map((builtService) => builtService.serviceReport),
    // Skipped services have no data in this run, so they don't count.
    metrics: rollUpMetrics(builtServices.filter((builtService) => !builtService.serviceReport.isSkipped).map((builtService) => builtService.metricsInput)),
  };
}
