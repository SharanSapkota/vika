// For every regression in the report: finds its stack frames, reads its top
// suspects' diffs (read-only git, passed in) and builds the request text.
// Nothing is sent here.
import { collectSecrets } from "../configuration/hide-secrets.js";
import type { LoadedConfiguration } from "../configuration/load-configuration.js";
import type { ServiceReportInput } from "../reporting/build-report.js";
import type { Report } from "../reporting/report-types.js";
import { applyPathMap, isRepoRelativePath } from "../suspect-attribution/apply-path-map.js";
import { buildExplanationRequest } from "./build-explanation-request.js";
import type { ExplanationFrame, ExplanationRequest } from "./explanation-types.js";
import type { readSuspectDiffs } from "./read-suspect-diffs.js";

export interface PreparedExplanation {
  serviceName: string;
  regressionIndex: number; // position in that service's regressions
  request: ExplanationRequest;
}

export interface PrepareExplanationRequestsInput {
  configuration: LoadedConfiguration;
  report: Report;
  serviceInputs: ServiceReportInput[]; // holds each error group's stack frames
  readDiffs: typeof readSuspectDiffs;
}

export async function prepareExplanationRequests(input: PrepareExplanationRequestsInput): Promise<PreparedExplanation[]> {
  const secrets = collectSecrets(input.configuration);
  const prepared: PreparedExplanation[] = [];
  for (const serviceReport of input.report.services) {
    const serviceSettings = input.configuration.services[serviceReport.serviceName];
    const serviceInput = input.serviceInputs.find((candidate) => candidate.serviceName === serviceReport.serviceName);
    if (serviceSettings === undefined) continue;
    for (const [regressionIndex, regression] of serviceReport.regressions.entries()) {
      const cluster = serviceInput?.clusters.find((candidate) => candidate.fingerprint === regression.fingerprint);
      // Frames as the repo knows them (pathMap applied), so they match git.
      const topFrames: ExplanationFrame[] = (cluster?.topFrames ?? []).map((frame) => {
        const mappedPath = applyPathMap(frame.file, serviceSettings.pathMap);
        return { filePath: isRepoRelativePath(mappedPath) ? mappedPath : frame.file, lineNumber: frame.line, functionName: frame.fn ?? null };
      });
      const stackTraceFilePaths = topFrames.map((frame) => frame.filePath).filter(isRepoRelativePath);
      const suspectDiffs = await input.readDiffs({ repoPath: serviceSettings.repo, suspects: regression.suspects, stackTraceFilePaths });
      const request = buildExplanationRequest({
        regression: { exceptionType: regression.exceptionType, message: regression.headline, topFrames },
        suspects: regression.suspects,
        suspectDiffs,
        maxDiffLines: input.configuration.explain.maxDiffLines,
        redactionKinds: input.configuration.redact,
        secrets,
      });
      prepared.push({ serviceName: serviceReport.serviceName, regressionIndex, request });
    }
  }
  return prepared;
}
