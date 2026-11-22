// PURE. A copy of the report with an `explanation` on every regression (the
// AI's answer, or null when nothing was sent or it failed). Nothing else in
// the report changes: the suspects and their order stay exactly as vika
// ranked them.
import type { Report } from "../reporting/report-types.js";
import type { Explanation } from "./explanation-types.js";

export interface RegressionExplanation {
  serviceName: string;
  regressionIndex: number;
  explanation: Explanation | null;
}

export function addExplanationsToReport(report: Report, explanations: RegressionExplanation[]): Report {
  return {
    ...report,
    services: report.services.map((serviceReport) => ({
      ...serviceReport,
      regressions: serviceReport.regressions.map((regression, regressionIndex) => ({
        ...regression,
        explanation:
          explanations.find((candidate) => candidate.serviceName === serviceReport.serviceName && candidate.regressionIndex === regressionIndex)
            ?.explanation ?? null,
      })),
    })),
  };
}
