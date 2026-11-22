// Tests the pure reporting code: the two delivery numbers, and the terminal
// text (a snapshot for the fixture, the "no strong suspect" wording, plain
// ASCII). The snapshot needs TEST_DATABASE_URL to build the fixture report.
import { afterAll, describe, expect, it } from "vitest";
import { runReportCommand } from "../src/commands/report-command.js";
import type { DeployStatus } from "../src/regression-detection/detection-types.js";
import { computeMetrics, rollUpMetrics } from "../src/reporting/compute-metrics.js";
import { formatTerminalReport } from "../src/reporting/format-terminal-report.js";
import { REPORT_SCHEMA_VERSION, type Report, type ServiceReport } from "../src/reporting/report-types.js";
import { NO_STRONG_SUSPECT_MESSAGE } from "../src/suspect-attribution/score-suspects.js";
import { buildReportProject, type ReportProject } from "./fixture/build-report-project.js";

const PLAIN_ASCII_TEXT = /^[\x20-\x7e\n]*$/;

const deploysWith = (statuses: DeployStatus[], failedCount: number) =>
  statuses.map((status, deployIndex) => ({ status, isFailed: deployIndex < failedCount }));

describe("computeMetrics", () => {
  it("0 failed of 4 judged deploys is 0%", () => {
    const metrics = computeMetrics({ deploys: deploysWith(["checked", "checked", "checked", "checked"], 0), regressions: [] });
    expect(metrics.changeFailureRate).toEqual({ label: "log-derived", value: 0, failedDeploys: 0, judgedDeploys: 4, note: null });
  });

  it("1 failed of 4 judged deploys is 25%; starting points and cold starts are not judged", () => {
    const deploys = [
      { status: "starting_point" as const, isFailed: false },
      { status: "insufficient_baseline" as const, isFailed: false },
      ...deploysWith(["checked", "checked", "checked", "checked"], 1),
    ];
    const metrics = computeMetrics({ deploys, regressions: [] });
    expect(metrics.changeFailureRate).toMatchObject({ value: 0.25, failedDeploys: 1, judgedDeploys: 4 });
  });

  it('no judged deploys gives "not enough data", not a division by zero', () => {
    const metrics = computeMetrics({ deploys: deploysWith(["starting_point", "insufficient_baseline"], 0), regressions: [] });
    expect(metrics.changeFailureRate).toEqual({ label: "log-derived", value: null, failedDeploys: 0, judgedDeploys: 0, note: "not enough data" });
    expect(metrics.medianTimeToRestore).toEqual({ label: "log-derived", valueMinutes: null, restoredRegressions: 0, note: "not enough data" });
    expect(metrics.ongoingRegressions).toEqual({ label: "log-derived", value: 0 });
  });

  it("median time to restore uses restored regressions only, and counts the ongoing ones", () => {
    const restoredAfter = (minutes: number) => ({
      firstSeen: "2026-03-06T14:00:00.000Z",
      restoredAt: new Date(Date.parse("2026-03-06T14:00:00.000Z") + minutes * 60_000).toISOString(),
    });
    const ongoing = { firstSeen: "2026-03-06T14:00:00.000Z", restoredAt: null };
    const oddCount = computeMetrics({ deploys: [], regressions: [restoredAfter(50), restoredAfter(10), restoredAfter(30), ongoing] });
    expect(oddCount.medianTimeToRestore).toMatchObject({ label: "log-derived", valueMinutes: 30, restoredRegressions: 3, note: null });
    expect(oddCount.ongoingRegressions.value).toBe(1);
    const evenCount = computeMetrics({ deploys: [], regressions: [restoredAfter(10), restoredAfter(40)] });
    expect(evenCount.medianTimeToRestore.valueMinutes).toBe(25);
  });

  it("rolls services up by pooling their deploys, not averaging their rates", () => {
    const rolledUp = rollUpMetrics([
      { deploys: deploysWith(["checked"], 1), regressions: [] },
      { deploys: deploysWith(["checked", "checked", "checked"], 0), regressions: [] },
    ]);
    expect(rolledUp.changeFailureRate).toMatchObject({ value: 0.25, failedDeploys: 1, judgedDeploys: 4 });
  });
});

// A small hand-made report with one regression and no suspects.
function makeReportWithoutSuspects(headline: string): Report {
  const metrics = computeMetrics({ deploys: deploysWith(["checked", "checked"], 1), regressions: [{ firstSeen: "2026-03-06T14:04:00.000Z", restoredAt: null }] });
  const service: ServiceReport = {
    serviceName: "payments-worker",
    isSkipped: false,
    notes: [],
    logEntryCount: 40,
    errorGroupCount: 3,
    deploys: [
      { deploySha: "a".repeat(40), time: "2026-03-05T10:00:00.000Z", status: "checked", isFailed: false },
      { deploySha: "b".repeat(40), time: "2026-03-06T14:00:00.000Z", status: "checked", isFailed: true },
    ],
    regressions: [
      {
        fingerprint: "0123456789ab",
        kind: "new",
        severity: "medium",
        headline,
        exceptionType: null,
        deploySha: "b".repeat(40),
        deployTime: "2026-03-06T14:00:00.000Z",
        firstSeen: "2026-03-06T14:04:00.000Z",
        occurrences: 25,
        baselineRatePerHour: 0,
        postDeployRatePerHour: 2.5,
        isAmbiguous: false,
        restoredAt: null,
        suspects: [],
        suspectMessage: NO_STRONG_SUSPECT_MESSAGE,
      },
    ],
    metrics,
  };
  return { schemaVersion: REPORT_SCHEMA_VERSION, asOf: "2026-03-06T23:59:00.000Z", services: [service], metrics };
}

describe("formatTerminalReport", () => {
  const projects: ReportProject[] = [];
  afterAll(() => projects.forEach((project) => project.remove()));

  it("prints the fixture report (snapshot)", async () => {
    const project = await buildReportProject("direct");
    projects.push(project);
    const { report } = await runReportCommand({ workingDirectory: project.folder, environment: project.environment, storeOptions: project.storeOptions });
    const text = formatTerminalReport(report, { useColor: false });
    expect(text).toMatchSnapshot();
    expect(text).toMatch(PLAIN_ASCII_TEXT);
    expect(text.toLowerCase()).not.toContain("culprit");
    expect(text).toContain("Change failure rate (log-derived): 25% (1 of 4 judged deploys)");
  }, 60_000);

  it('says "no strong suspect" when there is none', () => {
    const text = formatTerminalReport(makeReportWithoutSuspects("ECONNRESET talking to the payments provider"), { useColor: false });
    expect(text).toContain("Suspects: no strong suspect in this deploy; may be external");
    expect(text.toLowerCase()).not.toContain("culprit");
  });

  it("keeps log text plain ASCII and adds color codes only when asked", () => {
    const hostileHeadline = "\u001b[2Jcleared screen été ☃";
    const plainText = formatTerminalReport(makeReportWithoutSuspects(hostileHeadline), { useColor: false });
    expect(plainText).toMatch(PLAIN_ASCII_TEXT);
    expect(plainText).toContain("?[2Jcleared screen ?t? ?");

    const colorText = formatTerminalReport(makeReportWithoutSuspects(hostileHeadline), { useColor: true });
    expect(colorText).toContain("\u001b[1m"); // our own bold
    expect(colorText).not.toContain("\u001b[2J"); // never the log's escape code
  });
});
