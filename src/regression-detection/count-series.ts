import { floorToMinuteMs, parseTimeMs } from "./time-units.js";

export interface CountSeries {
  minutes: number[];
  runningTotals: number[];
}

export function mergeCounts(countsByMinute: Map<number, number>, countsPerMinute: Record<string, number>): void {
  for (const [minuteKey, count] of Object.entries(countsPerMinute)) {
    const minuteMs = floorToMinuteMs(parseTimeMs(minuteKey, "minute"));
    countsByMinute.set(minuteMs, Math.max(countsByMinute.get(minuteMs) ?? 0, count));
  }
}

export function buildCountSeries(countsByMinute: Map<number, number>): CountSeries {
  const minutes = [...countsByMinute.keys()].sort((left, right) => left - right);
  const runningTotals = [0];
  for (const minuteMs of minutes) runningTotals.push(runningTotals[runningTotals.length - 1]! + countsByMinute.get(minuteMs)!);
  return { minutes, runningTotals };
}

export function findFirstIndexAtOrAfter(minutes: number[], targetMinuteMs: number): number {
  let low = 0;
  let high = minutes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (minutes[middle]! < targetMinuteMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function sumCountsBetween(series: CountSeries, fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  return (
    series.runningTotals[findFirstIndexAtOrAfter(series.minutes, toMs)]! -
    series.runningTotals[findFirstIndexAtOrAfter(series.minutes, fromMs)]!
  );
}
