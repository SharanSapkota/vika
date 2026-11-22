// Turns the report object into text for a terminal. Pure.
//
// Plain ASCII only: anything else in log-derived text (including control
// characters, which could rewrite the terminal) becomes "?". Color codes
// are added only when the caller says the output is a terminal.
import type { Suspect } from "../suspect-attribution/suspect-types.js";
import type { DeliveryMetrics, Report, ReportRegression, ServiceReport } from "./report-types.js";

export interface FormatOptions {
  useColor: boolean;
}

const COLOR_CODES = { bold: "\u001b[1m", red: "\u001b[31m", yellow: "\u001b[33m", green: "\u001b[32m", dim: "\u001b[2m", reset: "\u001b[0m" };
type ColorName = Exclude<keyof typeof COLOR_CODES, "reset">;

const SHORT_SHA_LENGTH = 7;

// Printable ASCII only (space to "~").
function toPlainAscii(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?");
}

function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

function formatMinutes(totalMinutes: number): string {
  const roundedMinutes = Math.round(totalMinutes);
  if (roundedMinutes < 60) return `${roundedMinutes} min`;
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

const formatRate = (ratePerHour: number) => `${Math.round(ratePerHour * 10) / 10} per hour`;
const shortSha = (sha: string) => sha.slice(0, SHORT_SHA_LENGTH);

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function formatTerminalReport(report: Report, options: FormatOptions): string {
  const paint = (colorName: ColorName, text: string) => (options.useColor ? `${COLOR_CODES[colorName]}${text}${COLOR_CODES.reset}` : text);
  const severityColor: Record<ReportRegression["severity"], ColorName> = { high: "red", medium: "yellow", low: "dim" };
  const lines: string[] = [];

  const formatMetrics = (metrics: DeliveryMetrics, indent: string) => {
    const { changeFailureRate, medianTimeToRestore, ongoingRegressions } = metrics;
    lines.push(
      `${indent}Change failure rate (${changeFailureRate.label}): ` +
        (changeFailureRate.value === null
          ? `${changeFailureRate.note} (no judged deploys)`
          : `${paint("bold", formatPercent(changeFailureRate.value))} (${changeFailureRate.failedDeploys} of ${plural(changeFailureRate.judgedDeploys, "judged deploy")})`),
    );
    lines.push(
      `${indent}Median time to restore (${medianTimeToRestore.label}): ` +
        (medianTimeToRestore.valueMinutes === null
          ? `${medianTimeToRestore.note} (no restored regressions)`
          : `${paint("bold", formatMinutes(medianTimeToRestore.valueMinutes))} (over ${plural(medianTimeToRestore.restoredRegressions, "restored regression")})`),
    );
    lines.push(`${indent}Ongoing regressions (${ongoingRegressions.label}): ${ongoingRegressions.value}`);
  };

  const formatSuspect = (suspect: Suspect, suspectNumber: number) => {
    const pullRequest = suspect.prNumber === null ? "no PR" : `PR #${suspect.prNumber}`;
    const location = suspect.lineNumber === null ? suspect.filePath : `${suspect.filePath}:${suspect.lineNumber}`;
    const botNote = suspect.isBot ? " [bot]" : "";
    lines.push(`       ${suspectNumber}) ${pullRequest}  commit ${shortSha(suspect.commitSha)}  ${suspect.author.name} <${suspect.author.email}>${botNote}`);
    lines.push(`          ${location || "(no file)"}   confidence: ${suspect.confidence} (${suspect.evidenceKind})`);
    lines.push(`          why: ${suspect.reason}`);
  };

  const formatRegression = (regression: ReportRegression, regressionNumber: number) => {
    const kindText = regression.kind === "new" ? "NEW error" : "SPIKE in an existing error";
    const deployText = `deploy ${shortSha(regression.deploySha)}${regression.deployTime === null ? "" : ` (${regression.deployTime})`}`;
    lines.push(`  ${regressionNumber}. ${kindText} after ${deployText}   severity: ${paint(severityColor[regression.severity], regression.severity)}`);
    lines.push(`     ${regression.headline}`);
    lines.push(
      `     first seen ${regression.firstSeen}; ${plural(regression.occurrences, "time")} since ` +
        `(${formatRate(regression.postDeployRatePerHour)}; ${formatRate(regression.baselineRatePerHour)} before)`,
    );
    lines.push(`     status: ${regression.restoredAt === null ? paint("red", "ongoing") : paint("green", `restored at ${regression.restoredAt}`)}`);
    if (regression.isAmbiguous) lines.push("     note: another deploy happened shortly before this one; either could be the cause");
    if (regression.suspects.length === 0) {
      lines.push(`     Suspects: ${regression.suspectMessage ?? "none"}`);
    } else {
      lines.push("     Suspects:");
      regression.suspects.forEach((suspect, suspectIndex) => formatSuspect(suspect, suspectIndex + 1));
    }
  };

  const formatService = (serviceReport: ServiceReport) => {
    lines.push("", paint("bold", `== ${serviceReport.serviceName} ==`));
    for (const note of serviceReport.notes) lines.push(`Note: ${note}`);
    if (serviceReport.isSkipped) return;
    const judgedCount = serviceReport.deploys.filter((deploy) => deploy.status === "checked").length;
    const failedCount = serviceReport.deploys.filter((deploy) => deploy.isFailed).length;
    lines.push(`Log lines in: ${plural(serviceReport.logEntryCount, "error/warning line")} -> ${plural(serviceReport.errorGroupCount, "error group")}`);
    lines.push(`Deploys: ${serviceReport.deploys.length} (${judgedCount} judged, ${failedCount} failed)`);
    for (const deploy of serviceReport.deploys) {
      if (deploy.status === "insufficient_baseline") {
        lines.push(`  deploy ${shortSha(deploy.deploySha)} (${deploy.time}): insufficient baseline (less than 24 hours of logs before it), not judged`);
      }
    }
    lines.push(`Regressions: ${serviceReport.regressions.length}`);
    serviceReport.regressions.forEach((regression, regressionIndex) => formatRegression(regression, regressionIndex + 1));
    formatMetrics(serviceReport.metrics, "");
  };

  // Every string from the report (log-derived or not) is made plain ASCII
  // first; the only escape codes in the output are the ones paint() adds.
  const safeReport = toPlainAsciiEverywhere(report);
  lines.push(paint("bold", "vika report") + ` - as of ${safeReport.asOf ?? "(no logs read yet)"} (the latest log line read)`);
  safeReport.services.forEach(formatService);
  lines.push("", paint("bold", "== All services =="));
  formatMetrics(safeReport.metrics, "");
  return `${lines.join("\n")}\n`;
}

// A copy of the value with toPlainAscii applied to every string inside it.
function toPlainAsciiEverywhere<Value>(value: Value): Value {
  if (typeof value === "string") return toPlainAscii(value) as Value;
  if (Array.isArray(value)) return value.map((item) => toPlainAsciiEverywhere(item)) as Value;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlainAsciiEverywhere(item)])) as Value;
  }
  return value;
}
