// For one service, from what's stored: run the detector over all its
// clusters and deploys, then name suspects for each regression (git,
// read-only). Returns the input build-report needs.
//
// historyStart comes from the bookmarks (the first log line ever read) and
// dataEnd from the newest log line read, so no clock is involved: the same
// stored data always gives the same answer.
import type { ServiceSettings } from "../configuration/configuration-schema.js";
import type { Deploy, Store } from "../database/store-types.js";
import { listCommitsInRange } from "../deploys/commits-in-range.js";
import { detectRegressions } from "../regression-detection/detect-regressions.js";
import type { ServiceReportInput } from "../reporting/build-report.js";
import { attributeRegression } from "../suspect-attribution/attribute-regression.js";
import type { AttributionResult } from "../suspect-attribution/suspect-types.js";

export async function analyzeService(
  store: Store,
  serviceName: string,
  serviceSettings: ServiceSettings,
  deploys: Deploy[],
  notes: string[],
): Promise<ServiceReportInput> {
  const clusters = await store.listClusters(serviceName);
  const countsByFingerprint = await store.listClusterCounts(serviceName);
  const logHistory = await store.getLogHistory(serviceName);

  const detection = detectRegressions({
    service: serviceName,
    deploys,
    clusters: clusters.map((cluster) => ({
      fingerprint: cluster.fingerprint,
      firstSeen: cluster.firstSeen,
      lastSeen: cluster.lastSeen,
      countsPerMinute: countsByFingerprint[cluster.fingerprint] ?? {},
    })),
    ...(logHistory.historyStart === null ? {} : { historyStart: logHistory.historyStart }),
    ...(logHistory.lastLogTimestamp === null ? {} : { dataEnd: logHistory.lastLogTimestamp }),
  });

  const attributions: AttributionResult[] = [];
  for (const regression of detection.regressions) {
    const deploy = deploys.find((candidate) => candidate.sha === regression.deploySha)!;
    const cluster = clusters.find((candidate) => candidate.fingerprint === regression.fingerprint);
    attributions.push(
      await attributeRegression({
        repoPath: serviceSettings.repo,
        deploySha: deploy.sha,
        previousSha: deploy.previousSha,
        topFrames: cluster?.topFrames ?? [],
        ...(serviceSettings.pathMap === undefined ? {} : { pathMap: serviceSettings.pathMap }),
        commitsInRange: deploy.previousSha === null ? [] : await listCommitsInRange(serviceSettings.repo, deploy.previousSha, deploy.sha),
      }),
    );
  }

  return {
    serviceName,
    isSkipped: false,
    notes,
    clusters,
    countsByFingerprint,
    deploys,
    detection,
    attributions,
    lastLogTimestamp: logHistory.lastLogTimestamp,
  };
}
