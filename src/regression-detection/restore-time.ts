import { sumCountsBetween, type CountSeries } from "./count-series.js";
import { isAboveNoise } from "./noise-check.js";
import { floorToMinuteMs, MINUTE_MS, toIsoTimestamp } from "./time-units.js";

// The first minute after which the group stays at baseline level: every
// quietMinutes window from then on is within normal noise for the
// baseline rate (for a new group: zero occurrences). It must be confirmed by
// a full quiet window inside the data, otherwise null (still ongoing).
export function findRestoreTime(
  series: CountSeries,
  startMs: number,
  baselineRate: number,
  quietMinutes: number,
  dataEndMs: number,
): string | null {
  const quietWindowMs = quietMinutes * MINUTE_MS;
  const expected = (baselineRate * quietMinutes) / 60;
  let lastNoisyMinuteMs: number | undefined;
  for (let minuteMs = floorToMinuteMs(startMs); minuteMs < dataEndMs; minuteMs += MINUTE_MS) {
    if (isAboveNoise(sumCountsBetween(series, minuteMs, minuteMs + quietWindowMs), expected)) lastNoisyMinuteMs = minuteMs;
  }
  const restoredMs = lastNoisyMinuteMs === undefined ? floorToMinuteMs(startMs) : lastNoisyMinuteMs + MINUTE_MS;
  return restoredMs + quietWindowMs <= dataEndMs ? toIsoTimestamp(restoredMs) : null;
}
