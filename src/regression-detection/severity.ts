import type { Severity } from "./detection-types.js";

export function severityOf(occurrences: number, postRatePerHour: number): Severity {
  if (occurrences >= 100 || postRatePerHour >= 60) return "high";
  if (occurrences >= 20 || postRatePerHour >= 10) return "medium";
  return "low";
}
