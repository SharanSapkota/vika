import type { Severity } from "./detection-types.js";

// Severity from how many times it happened and how fast:
//   high:   100+ occurrences, or 60+ per hour (one a minute)
//   medium: 20+ occurrences,  or 10+ per hour
//   low:    anything else that still passed minCount
export function severityOf(occurrences: number, postRatePerHour: number): Severity {
  if (occurrences >= 100 || postRatePerHour >= 60) return "high";
  if (occurrences >= 20 || postRatePerHour >= 10) return "medium";
  return "low";
}
