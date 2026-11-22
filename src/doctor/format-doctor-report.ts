// Doctor's checks as terminal text, one line each, with the fix under it.
// Pure; plain ASCII.
import type { DoctorCheck } from "./doctor-check-types.js";

export function formatDoctorReport(checks: DoctorCheck[]): string {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${check.level.padEnd(4)} ${check.area}: ${check.message}`);
    if (check.fix !== null) lines.push(`     fix: ${check.fix}`);
  }
  const failCount = checks.filter((check) => check.level === "FAIL").length;
  const warnCount = checks.filter((check) => check.level === "WARN").length;
  lines.push(
    "",
    failCount === 0
      ? `All set${warnCount > 0 ? `, with ${warnCount} ${warnCount === 1 ? "warning" : "warnings"}` : ""}.`
      : `${failCount} ${failCount === 1 ? "problem" : "problems"} to fix (and ${warnCount} ${warnCount === 1 ? "warning" : "warnings"}).`,
  );
  return `${lines.join("\n").replace(/[^\x20-\x7e\n]/g, "?")}\n`;
}
