// Sets up what a customer would have, for the fixture: a vika.yaml in a temp
// folder pointing at the fixture repo and log, marker deploys recorded with
// `mark-deploy` from deploys.json, and a fresh Postgres schema of its own
// (so tests never see each other's data). Needs TEST_DATABASE_URL.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMarkDeployCommand } from "../../src/commands/mark-deploy-command.js";
import { runCli } from "../../src/commands/run-cli.js";
import type { StoreOptions } from "../../src/database/store-types.js";
import type { FetchFunction } from "../../src/ticket-trackers/tracker-types.js";
import { buildFixture, type Fixture, type Scenario } from "./build.js";
import { createForbiddenFetch } from "./fake-trackers.js";

const stripColor = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

export const FIXTURE_SERVICE_NAME = "shopfront";

// Any fixed time: mark-deploy always gets an explicit --time here.
const FIXED_CLOCK = () => new Date("2026-03-11T00:00:00.000Z");

// How a person at the terminal behaves during one vika run.
export interface TerminalSession {
  fetchFunction?: FetchFunction; // default: any network call is recorded and fails
  isInteractive?: boolean; // default: false (like a pipe or CI)
  answers?: string[]; // typed answers, in order
  environment?: Record<string, string>; // replaces these variables for this run only
  storeOptions?: StoreOptions; // e.g. a fresh, empty schema for this run only
}

export interface ReportProject {
  folder: string; // holds vika.yaml
  fixture: Fixture;
  environment: Record<string, string>;
  storeOptions: StoreOptions;
  networkCalls: string[]; // URLs anything tried to fetch without a fake fetch
  // Runs `vika <arguments>` in the project folder and captures the output.
  runVika(argumentList: string[], session?: TerminalSession): Promise<{ exitCode: number; output: string; errorOutput: string; questions: string[] }>;
  remove(): void;
}

export function readTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is not set. Copy .env.example to .env.");
  return databaseUrl;
}

export function makeTestSchemaName(): string {
  return `test_${randomBytes(6).toString("hex")}`;
}

export interface ReportProjectOptions {
  logPath?: string; // default: the fixture's own app.log
  fixture?: Fixture; // reuse an already built fixture
  trackerYamlLines?: string[]; // e.g. ["tracker:", "  type: jira", "  project: OPS"]
  extraEnvironment?: Record<string, string>; // e.g. the JIRA_* variables
  isPathMapIncluded?: boolean; // default true: map /app/src to src
  deploySource?: string; // default "marker"
  shouldMarkDeploys?: boolean; // default true: record deploys.json with mark-deploy
  extraServiceYamlLines?: string[]; // more services, indented under "services:"
  explainYamlLines?: string[]; // e.g. ["explain:", "  enabled: true"]
}

export async function buildReportProject(scenario: Scenario, options: ReportProjectOptions = {}): Promise<ReportProject> {
  const fixture = options.fixture ?? buildFixture(scenario);
  const folder = mkdtempSync(join(tmpdir(), "vika-report-project-"));
  const environment = { DATABASE_URL: readTestDatabaseUrl(), ...options.extraEnvironment };
  const storeOptions: StoreOptions = { schema: makeTestSchemaName() };
  const networkCalls: string[] = [];

  writeFileSync(
    join(folder, "vika.yaml"),
    [
      "services:",
      `  ${FIXTURE_SERVICE_NAME}:`,
      `    repo: ${JSON.stringify(fixture.repoDir)}`,
      `    logs: ${JSON.stringify(options.logPath ?? fixture.logPath)}`,
      ...((options.isPathMapIncluded ?? true) ? ["    pathMap:", "      /app/src: src"] : []),
      // The Python fixtures need their language; JavaScript is the default.
      ...(fixture.expected.language === "python" ? ["    language: python"] : []),
      "    deploys:",
      `      source: ${options.deploySource ?? "marker"}`,
      ...(options.extraServiceYamlLines ?? []),
      ...(options.trackerYamlLines ?? []),
      ...(options.explainYamlLines ?? []),
      "",
    ].join("\n"),
  );

  try {
    for (const deploy of (options.shouldMarkDeploys ?? true) ? fixture.deploys : []) {
      await runMarkDeployCommand({
        workingDirectory: folder,
        environment,
        storeOptions,
        serviceName: FIXTURE_SERVICE_NAME,
        sha: deploy.sha,
        ...(deploy.previousSha === null ? {} : { previousSha: deploy.previousSha }),
        time: deploy.time,
        clock: FIXED_CLOCK,
      });
    }
  } catch (error) {
    // Setup failed: don't leave the temp folders behind.
    rmSync(folder, { recursive: true, force: true });
    if (options.fixture === undefined) rmSync(fixture.root, { recursive: true, force: true });
    throw error;
  }

  return {
    folder,
    fixture,
    environment,
    storeOptions,
    networkCalls,
    async runVika(argumentList, session = {}) {
      let output = "";
      let errorOutput = "";
      const questions: string[] = [];
      const remainingAnswers = [...(session.answers ?? [])];
      const isInteractive = session.isInteractive ?? false;
      const exitCode = await runCli(argumentList, {
        writeOutput: (text) => (output += text),
        writeError: (text) => (errorOutput += text),
        // Interactive means both ends are a terminal; color stays off for
        // readable assertions (the formatter's color is tested on its own).
        isOutputTerminal: isInteractive,
        isInputTerminal: isInteractive,
        ask: async (question) => {
          questions.push(question);
          return remainingAnswers.shift() ?? "";
        },
        fetchFunction: session.fetchFunction ?? createForbiddenFetch(networkCalls),
        environment: { ...environment, ...session.environment },
        workingDirectory: folder,
        clock: FIXED_CLOCK,
        storeOptions: session.storeOptions ?? storeOptions,
      });
      return { exitCode, output: isInteractive ? stripColor(output) : output, errorOutput, questions };
    },
    remove() {
      rmSync(folder, { recursive: true, force: true });
      if (options.fixture === undefined) rmSync(fixture.root, { recursive: true, force: true });
    },
  };
}
