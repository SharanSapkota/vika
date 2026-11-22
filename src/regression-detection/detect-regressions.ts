import { buildCountSeries, findFirstIndexAtOrAfter, mergeCounts, sumCountsBetween, type CountSeries } from "./count-series.js";
import {
  DEFAULT_DETECT_OPTIONS,
  type DeployStatus,
  type DetectInput,
  type DetectOptions,
  type DetectResult,
  type Regression,
} from "./detection-types.js";
import { isAboveNoise } from "./noise-check.js";
import { findRestoreTime } from "./restore-time.js";
import { severityOf } from "./severity.js";
import { floorToMinuteMs, HOUR_MS, MINUTE_MS, parseTimeMs, toIsoTimestamp } from "./time-units.js";

const roundToThreeDecimals = (value: number) => Math.round(value * 1000) / 1000;

interface GroupCounts {
  fingerprint: string;
  series: CountSeries;
  firstSeenMs: number;
  firstSeenIso: string;
}

interface DeployWindow {
  sha: string;
  timeMs: number;
  startMs: number;
  endMs: number;
  status: DeployStatus;
}

export function detectRegressions(input: DetectInput): DetectResult {
  const options: DetectOptions = { ...DEFAULT_DETECT_OPTIONS, ...input.options };
  const newWindowMs = options.newWindowMinutes * MINUTE_MS;
  const baselineSpanMs = options.baselineDays * 24 * HOUR_MS;

  const isForThisService = <T extends { service?: string }>(item: T) => item.service === undefined || item.service === input.service;

  const groups: GroupCounts[] = [];
  const baselineOnlyCounts = new Map(Object.entries(input.baseline ?? {}));
  const sortedClusters = [...input.clusters.filter(isForThisService)].sort((left, right) =>
    left.fingerprint < right.fingerprint ? -1 : left.fingerprint > right.fingerprint ? 1 : 0,
  );
  for (const cluster of sortedClusters) {
    const countsByMinute = new Map<number, number>();
    mergeCounts(countsByMinute, cluster.countsPerMinute);
    const baselineCountsForCluster = baselineOnlyCounts.get(cluster.fingerprint);
    if (baselineCountsForCluster) mergeCounts(countsByMinute, baselineCountsForCluster);
    baselineOnlyCounts.delete(cluster.fingerprint);
    const series = buildCountSeries(countsByMinute);
    const clusterFirstSeenMs = parseTimeMs(cluster.firstSeen, "firstSeen");
    const firstCountedMinuteMs = series.minutes[0];
    const firstSeenMs =
      firstCountedMinuteMs !== undefined && firstCountedMinuteMs < floorToMinuteMs(clusterFirstSeenMs) ? firstCountedMinuteMs : clusterFirstSeenMs;
    groups.push({ fingerprint: cluster.fingerprint, series, firstSeenMs, firstSeenIso: toIsoTimestamp(firstSeenMs) });
  }

  let earliestMs = Infinity;
  let latestMs = -Infinity;
  for (const group of groups) {
    earliestMs = Math.min(earliestMs, group.firstSeenMs);
    if (group.series.minutes.length > 0) latestMs = Math.max(latestMs, group.series.minutes[group.series.minutes.length - 1]! + MINUTE_MS);
  }
  for (const countsPerMinute of baselineOnlyCounts.values()) {
    for (const minuteKey of Object.keys(countsPerMinute)) {
      const minuteMs = floorToMinuteMs(parseTimeMs(minuteKey, "minute"));
      earliestMs = Math.min(earliestMs, minuteMs);
      latestMs = Math.max(latestMs, minuteMs + MINUTE_MS);
    }
  }
  const historyStartMs = input.historyStart !== undefined ? parseTimeMs(input.historyStart, "historyStart") : earliestMs;
  const dataEndMs = input.dataEnd !== undefined ? parseTimeMs(input.dataEnd, "dataEnd") : latestMs;

  const sortedDeploys = input.deploys
    .filter(isForThisService)
    .map((deploy, inputIndex) => ({ deploy, inputIndex, timeMs: parseTimeMs(deploy.time, "deploy time") }))
    .sort((left, right) => left.timeMs - right.timeMs || left.inputIndex - right.inputIndex);
  const deploys: DeployWindow[] = sortedDeploys.map(({ deploy, timeMs }, deployIndex) => {
    const nextDeploy = sortedDeploys[deployIndex + 1];
    const hasEnoughHistory = Number.isFinite(historyStartMs) && timeMs - historyStartMs >= options.minBaselineHours * HOUR_MS;
    return {
      sha: deploy.sha,
      timeMs,
      startMs: floorToMinuteMs(timeMs),
      endMs: Math.min(nextDeploy ? floorToMinuteMs(nextDeploy.timeMs) : Infinity, dataEndMs),
      status: deploy.previousSha === null ? "starting_point" : hasEnoughHistory ? "checked" : "insufficient_baseline",
    };
  });

  const isAmbiguous = (deployIndex: number) =>
    deploys.some(
      (otherDeploy, otherIndex) =>
        otherIndex !== deployIndex &&
        otherDeploy.timeMs <= deploys[deployIndex]!.timeMs &&
        deploys[deployIndex]!.timeMs - otherDeploy.timeMs <= newWindowMs,
    );

  const regressions: (Regression & { deployOrder: number })[] = [];
  const addRegression = (deployIndex: number, group: GroupCounts, kind: "new" | "spike", firstSeen: string, baselineRate: number) => {
    const deploy = deploys[deployIndex]!;
    const occurrences = sumCountsBetween(group.series, deploy.startMs, deploy.endMs);
    const windowHours = (deploy.endMs - deploy.startMs) / HOUR_MS;
    const postRate = windowHours > 0 ? occurrences / windowHours : 0;
    regressions.push({
      fingerprint: group.fingerprint,
      deploySha: deploy.sha,
      kind,
      firstSeen,
      occurrences,
      baselineRate: roundToThreeDecimals(baselineRate),
      postRate: roundToThreeDecimals(postRate),
      ambiguous: isAmbiguous(deployIndex),
      severity: severityOf(occurrences, postRate),
      restoredAt: findRestoreTime(
        group.series,
        kind === "new" ? group.firstSeenMs : deploy.startMs,
        baselineRate,
        options.restoreQuietMinutes,
        dataEndMs,
      ),
      deployOrder: deployIndex,
    });
  };

  for (const group of groups) {
    let latestDeployIndex = -1;
    for (let deployIndex = 0; deployIndex < deploys.length; deployIndex++) {
      if (deploys[deployIndex]!.timeMs <= group.firstSeenMs) latestDeployIndex = deployIndex;
    }
    const latestDeploy = deploys[latestDeployIndex];
    if (
      latestDeploy &&
      latestDeploy.status === "checked" &&
      group.firstSeenMs - latestDeploy.timeMs <= newWindowMs &&
      sumCountsBetween(group.series, latestDeploy.timeMs - baselineSpanMs, latestDeploy.startMs) === 0 &&
      sumCountsBetween(group.series, latestDeploy.startMs, latestDeploy.endMs) >= options.minCount
    ) {
      addRegression(latestDeployIndex, group, "new", group.firstSeenIso, 0);
    }

    for (let deployIndex = 0; deployIndex < deploys.length; deployIndex++) {
      const deploy = deploys[deployIndex]!;
      if (deploy.status !== "checked") continue;
      const baselineStartMs = Math.max(deploy.timeMs - baselineSpanMs, historyStartMs, floorToMinuteMs(group.firstSeenMs));
      const baselineCount = sumCountsBetween(group.series, baselineStartMs, deploy.startMs);
      const baselineHours = (deploy.startMs - baselineStartMs) / HOUR_MS;
      if (baselineCount === 0 || baselineHours <= 0) continue;
      const baselineRate = baselineCount / baselineHours;

      const windowEndMs = Math.min(deploy.startMs + newWindowMs, deploy.endMs);
      if (windowEndMs <= deploy.startMs) continue;
      const observed = sumCountsBetween(group.series, deploy.startMs, windowEndMs);
      const expected = baselineRate * ((windowEndMs - deploy.startMs) / HOUR_MS);
      if (observed < options.minCount || observed < options.spikeFactor * expected || !isAboveNoise(observed, expected)) continue;

      const firstMinuteAfterDeployMs = group.series.minutes[findFirstIndexAtOrAfter(group.series.minutes, deploy.startMs)]!;
      addRegression(deployIndex, group, "spike", toIsoTimestamp(firstMinuteAfterDeployMs), baselineRate);
    }
  }

  regressions.sort(
    (left, right) =>
      left.deployOrder - right.deployOrder ||
      (left.firstSeen < right.firstSeen ? -1 : left.firstSeen > right.firstSeen ? 1 : 0) ||
      (left.fingerprint < right.fingerprint ? -1 : 1),
  );

  return {
    regressions: regressions.map(({ deployOrder: _deployOrder, ...regression }) => regression),
    deploys: deploys.map((deploy, deployIndex) => ({
      deploySha: deploy.sha,
      time: toIsoTimestamp(deploy.timeMs),
      status: deploy.status,
      failed: regressions.some((regression) => regression.deployOrder === deployIndex && regression.severity !== "low"),
    })),
  };
}
