



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
