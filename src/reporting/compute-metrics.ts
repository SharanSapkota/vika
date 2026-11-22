// The two delivery numbers, from detector output only. Pure.
//
//   change failure rate = failed deploys / judged deploys
//     Judged means the detector could check it: starting points and deploys
//     with too little history ("insufficient_baseline") are left out, so a
//     cold start never looks like a perfect record.
//   median time to restore = median of (restoredAt - firstSeen) over the
//     regressions that were restored; ongoing ones are counted separately.
//
// With nothing to measure, a number is null with the note "not enough
// data", never a division by zero.
import type { DeployStatus } from "../regression-detection/detection-types.js";
import { LOG_DERIVED, NOT_ENOUGH_DATA, type DeliveryMetrics } from "./report-types.js";

const MINUTE_MS = 60_000;

export interface MetricsInput {
  deploys: { status: DeployStatus; isFailed: boolean }[];
  regressions: { firstSeen: string; restoredAt: string | null }[];
}

function findMedian(sortedValues: number[]): number {
  const middleIndex = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1 ? sortedValues[middleIndex]! : (sortedValues[middleIndex - 1]! + sortedValues[middleIndex]!) / 2;
}

export function computeMetrics(input: MetricsInput): DeliveryMetrics {
  const judgedDeploys = input.deploys.filter((deploy) => deploy.status === "checked");
  const failedDeploys = judgedDeploys.filter((deploy) => deploy.isFailed).length;

  const restoreMinutes = input.regressions
    .filter((regression) => regression.restoredAt !== null)
    .map((regression) => (Date.parse(regression.restoredAt!) - Date.parse(regression.firstSeen)) / MINUTE_MS)
    .sort((left, right) => left - right);

  return {
    changeFailureRate: {
      label: LOG_DERIVED,
      value: judgedDeploys.length === 0 ? null : failedDeploys / judgedDeploys.length,
      failedDeploys,
      judgedDeploys: judgedDeploys.length,
      note: judgedDeploys.length === 0 ? NOT_ENOUGH_DATA : null,
    },
    medianTimeToRestore: {
      label: LOG_DERIVED,
      valueMinutes: restoreMinutes.length === 0 ? null : findMedian(restoreMinutes),
      restoredRegressions: restoreMinutes.length,
      note: restoreMinutes.length === 0 ? NOT_ENOUGH_DATA : null,
    },
    ongoingRegressions: {
      label: LOG_DERIVED,
      value: input.regressions.length - restoreMinutes.length,
    },
  };
}

// All services together: their deploys and regressions pooled, not their
// rates averaged (a service with 1 deploy shouldn't weigh as much as one with 50).
export function rollUpMetrics(serviceInputs: MetricsInput[]): DeliveryMetrics {
  return computeMetrics({
    deploys: serviceInputs.flatMap((serviceInput) => serviceInput.deploys),
    regressions: serviceInputs.flatMap((serviceInput) => serviceInput.regressions),
  });
}
