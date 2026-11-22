import { lineTimestamp } from "../log-parsing/read-line-timestamp.js";

export function findTimestampRange(lines: string[]): { earliest: string; newest: string } | undefined {
  let earliest: string | undefined;
  let newest: string | undefined;
  for (const line of lines) {
    const timestamp = lineTimestamp(line);
    if (timestamp === undefined) continue;
    if (earliest === undefined || timestamp < earliest) earliest = timestamp;
    if (newest === undefined || timestamp > newest) newest = timestamp;
  }
  return earliest === undefined || newest === undefined ? undefined : { earliest, newest };
}
