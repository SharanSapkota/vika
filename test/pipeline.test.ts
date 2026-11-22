// Tests the report pipeline's guarantees: running twice counts nothing twice,
// a cold start is never judged, and a run that finds the lock taken skips
// cleanly. Needs TEST_DATABASE_URL.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReportCommand } from "../src/commands/report-command.js";
import { openStore } from "../src/database/database-store.js";
import { buildFixture, type Fixture } from "./fixture/build.js";
import { buildReportProject, FIXTURE_SERVICE_NAME, readTestDatabaseUrl, type ReportProject } from "./fixture/build-report-project.js";

const HOUR_MS = 3_600_000;

// Keeps only the log lines from `startMs` on; untimed lines (stack traces)
// follow the timed line before them.
function writeLogFrom(sourceLogPath: string, targetLogPath: string, startMs: number): void {
  let isKeeping = false;
  const keptLines = readFileSync(sourceLogPath, "utf8")
    .split("\n")
    .filter((line) => {
      const timestampMatch = /^(\d{4}-\d{2}-\d{2}T\S+Z) /.exec(line);
      if (timestampMatch) isKeeping = Date.parse(timestampMatch[1]!) >= startMs;
      return isKeeping && line !== "";
    });
  writeFileSync(targetLogPath, `${keptLines.join("\n")}\n`);
}

describe("report pipeline", () => {
  let fixture: Fixture;
  const projects: ReportProject[] = [];

  beforeAll(() => {
    fixture = buildFixture("direct");
  }, 60_000);

  afterAll(() => {
    projects.forEach((project) => project.remove());
    // The fixture is shared, so the projects leave it; remove it here.
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const startProject = async (logPath?: string) => {
    const project = await buildReportProject("direct", { fixture, ...(logPath === undefined ? {} : { logPath }) });
    projects.push(project);
    return project;
  };

  const runReport = (project: ReportProject) =>
    runReportCommand({ workingDirectory: project.folder, environment: project.environment, storeOptions: project.storeOptions });

  it("is idempotent: a second run reads nothing new, counts nothing twice and gives the same report", async () => {
    const project = await startProject();
    const store = await openStore(readTestDatabaseUrl(), project.storeOptions);
    try {
      const firstRun = await runReport(project);
      const countsAfterFirstRun = await store.listClusterCounts(FIXTURE_SERVICE_NAME);
      const secondRun = await runReport(project);
      const countsAfterSecondRun = await store.listClusterCounts(FIXTURE_SERVICE_NAME);

      expect(firstRun.runNotes[0]).toMatch(/read [1-9]\d* new log lines/);
      expect(secondRun.runNotes[0]).toContain("read 0 new log lines");
      expect(countsAfterSecondRun).toEqual(countsAfterFirstRun);
      expect(JSON.stringify(secondRun.report)).toBe(JSON.stringify(firstRun.report));
      expect(firstRun.report.services[0]!.regressions).toHaveLength(1);
    } finally {
      await store.close();
    }
  }, 60_000);

  it("cold start: under 24 hours of history gives insufficient baseline and no regression", async () => {
    // Logs that begin only 12 hours before the bad deploy.
    const badDeployMs = Date.parse(fixture.deploys.find((deploy) => deploy.sha === fixture.expected.badDeploySha)!.time);
    const shortLogPath = join(fixture.root, "short-history.log");
    writeLogFrom(fixture.logPath, shortLogPath, badDeployMs - 12 * HOUR_MS);
    const project = await startProject(shortLogPath);

    const { report } = await runReport(project);
    const service = report.services[0]!;
    expect(service.regressions).toEqual([]);
    expect(service.deploys.find((deploy) => deploy.deploySha === fixture.expected.badDeploySha)!.status).toBe("insufficient_baseline");
  }, 60_000);

  it("busy lock: a run that finds the service locked skips it cleanly and stores nothing", async () => {
    const project = await startProject();
    const store = await openStore(readTestDatabaseUrl(), project.storeOptions);
    try {
      const lockResult = await store.withRunLock(FIXTURE_SERVICE_NAME, () => runReport(project));
      if (lockResult === "busy") throw new Error("the test itself could not take the lock");
      const service = lockResult.report.services[0]!;
      expect(service.isSkipped).toBe(true);
      expect(service.notes[0]).toMatch(/another vika run is working on service "shopfront"/);
      expect(service.regressions).toEqual([]);
      expect(await store.listClusters(FIXTURE_SERVICE_NAME)).toEqual([]);
    } finally {
      await store.close();
    }
  }, 60_000);
});
