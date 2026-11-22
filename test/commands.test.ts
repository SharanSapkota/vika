// Tests the commands behind the CLI: mark-deploy, the CLI's errors and exit
// codes, and that no secret ever reaches the output. Needs TEST_DATABASE_URL.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectSecrets, hideSecrets } from "../src/configuration/hide-secrets.js";
import { APPROVAL_QUESTION, approveAndCreateTickets, type ApprovalConsole } from "../src/commands/approve-and-create-tickets.js";
import { runMarkDeployCommand, type MarkDeployOptions } from "../src/commands/mark-deploy-command.js";
import type { CreateTicketOutcome } from "../src/ticketing/create-ticket.js";
import type { TicketDraft } from "../src/ticketing/ticket-types.js";
import { runCli } from "../src/commands/run-cli.js";
import type { LoadedConfiguration } from "../src/configuration/load-configuration.js";
import { openStore } from "../src/database/database-store.js";
import type { StoreOptions } from "../src/database/store-types.js";
import { buildReportProject, makeTestSchemaName, readTestDatabaseUrl, type ReportProject } from "./fixture/build-report-project.js";
import { createForbiddenFetch } from "./fixture/fake-trackers.js";

const FIRST_SHA = "1".repeat(40);
const SECOND_SHA = "2".repeat(40);
const CLOCK_TIME = "2026-05-01T12:00:00.000Z";
const fixedClock = () => new Date(CLOCK_TIME);

const temporaryFolders: string[] = [];
const projects: ReportProject[] = [];
afterAll(() => {
  temporaryFolders.forEach((folder) => rmSync(folder, { recursive: true, force: true }));
  projects.forEach((project) => project.remove());
});

// A folder with a vika.yaml for one marker-deploy service.
function makeMarkerProject(): { folder: string; storeOptions: StoreOptions; environment: Record<string, string> } {
  const folder = mkdtempSync(join(tmpdir(), "vika-commands-"));
  temporaryFolders.push(folder);
  writeFileSync(join(folder, "vika.yaml"), "services:\n  api:\n    repo: ./repo\n    logs: ./api.log\n    deploys:\n      source: marker\n");
  return { folder, storeOptions: { schema: makeTestSchemaName() }, environment: { DATABASE_URL: readTestDatabaseUrl() } };
}

async function runVikaIn(folder: string, environment: Record<string, string>, storeOptions: StoreOptions, argumentList: string[]) {
  let output = "";
  let errorOutput = "";
  const exitCode = await runCli(argumentList, {
    writeOutput: (text) => (output += text),
    writeError: (text) => (errorOutput += text),
    isOutputTerminal: false,
    isInputTerminal: false,
    ask: async () => "",
    fetchFunction: createForbiddenFetch([]),
    environment,
    workingDirectory: folder,
    clock: fixedClock,
    storeOptions,
  });
  return { exitCode, output, errorOutput };
}

describe("mark-deploy", () => {
  it("saves a deploy once; marking it again keeps one row", async () => {
    const project = makeMarkerProject();
    const options: MarkDeployOptions = { workingDirectory: project.folder, environment: project.environment, storeOptions: project.storeOptions, serviceName: "api", sha: FIRST_SHA, time: "2026-04-01T10:00:00Z", clock: fixedClock };

    const firstMark = await runMarkDeployCommand(options);
    const secondMark = await runMarkDeployCommand(options);
    expect(firstMark.isNew).toBe(true);
    expect(secondMark.isNew).toBe(false);
    expect(firstMark.deploy).toEqual({ service: "api", sha: FIRST_SHA, previousSha: null, time: "2026-04-01T10:00:00.000Z", source: "marker" });

    const store = await openStore(readTestDatabaseUrl(), project.storeOptions);
    try {
      expect(await store.listDeploys("api")).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("defaults the time to the clock and the previous sha to the latest earlier deploy", async () => {
    const project = makeMarkerProject();
    const common = { workingDirectory: project.folder, environment: project.environment, storeOptions: project.storeOptions, serviceName: "api", clock: fixedClock };
    await runMarkDeployCommand({ ...common, sha: FIRST_SHA, time: "2026-04-01T10:00:00Z" });
    const { deploy } = await runMarkDeployCommand({ ...common, sha: SECOND_SHA });
    expect(deploy).toMatchObject({ sha: SECOND_SHA, previousSha: FIRST_SHA, time: CLOCK_TIME });
  });

  it("rejects a bad sha, a bad time and an unknown service with a clear message and exit code 1", async () => {
    const project = makeMarkerProject();
    const runMarkDeploy = (extraArguments: string[]) =>
      runVikaIn(project.folder, project.environment, project.storeOptions, ["mark-deploy", "--service", "api", ...extraArguments]);

    const badSha = await runMarkDeploy(["--sha", "abc123"]);
    expect(badSha.exitCode).toBe(1);
    expect(badSha.errorOutput).toBe('vika: --sha must be a full 40-character commit sha (got "abc123")\n');

    const badTime = await runMarkDeploy(["--sha", FIRST_SHA, "--time", "yesterday"]);
    expect(badTime.exitCode).toBe(1);
    expect(badTime.errorOutput).toBe('vika: --time must be an ISO date and time, like 2026-03-06T14:00:00Z (got "yesterday")\n');

    const unknownService = await runVikaIn(project.folder, project.environment, project.storeOptions, ["mark-deploy", "--service", "billing", "--sha", FIRST_SHA]);
    expect(unknownService.exitCode).toBe(1);
    expect(unknownService.errorOutput).toMatch(/^vika: service "billing" is not in .*vika\.yaml \(services: api\)\n$/);

    const saved = await runMarkDeploy(["--sha", FIRST_SHA, "--time", "2026-04-01T10:00:00Z"]);
    expect(saved).toMatchObject({ exitCode: 0, errorOutput: "" });
    expect(saved.output).toContain(`Saved: api deploy of ${FIRST_SHA} at 2026-04-01T10:00:00.000Z`);
  });
});

describe("secrets", () => {
  const SECRET_PASSWORD = "Sup3r-Secret-Pa55word";

  it("an error never shows the database password", async () => {
    const project = makeMarkerProject();
    // Nothing listens on port 1, so connecting fails.
    const environment = { DATABASE_URL: `postgres://vika:${SECRET_PASSWORD}@127.0.0.1:1/vika` };
    for (const argumentList of [["report"], ["report", "--json"], ["mark-deploy", "--service", "api", "--sha", FIRST_SHA]]) {
      const result = await runVikaIn(project.folder, environment, project.storeOptions, argumentList);
      expect(result.exitCode).toBe(1);
      expect(result.errorOutput).toMatch(/^vika: /);
      expect(result.output + result.errorOutput).not.toContain(SECRET_PASSWORD);
    }
  });

  it("report output, text and JSON, never shows the database password", async () => {
    const project = await buildReportProject("direct");
    projects.push(project);
    const databaseUrl = new URL(project.environment.DATABASE_URL!);
    const credentials = `${databaseUrl.username}:${databaseUrl.password}@`;
    for (const argumentList of [["report"], ["report", "--json"]]) {
      const result = await project.runVika(argumentList);
      expect(result.exitCode).toBe(0);
      const everything = result.output + result.errorOutput;
      expect(everything).not.toContain(project.environment.DATABASE_URL);
      expect(everything).not.toContain(credentials);
      expect(everything).toContain(`${databaseUrl.username}:****@`);
    }
  }, 60_000);

  it("hideSecrets masks the password, the whole URL and tracker tokens", () => {
    const configuration = {
      databaseUrl: `postgres://vika:${SECRET_PASSWORD}@db.example.com/vika`,
      trackerCredentials: { type: "jira", baseUrl: "https://example.atlassian.net", email: "ops@example.com", apiToken: "jira-token-xyz" },
      webhook: null,
    } as LoadedConfiguration;
    const message = `could not connect with postgres://vika:${SECRET_PASSWORD}@db.example.com/vika (password ${SECRET_PASSWORD}); token jira-token-xyz`;
    const masked = hideSecrets(message, collectSecrets(configuration));
    expect(masked).toBe("could not connect with **** (password ****); token ****");
  });
});

describe("approving tickets", () => {
  const DRAFT: TicketDraft = {
    service: "shopfront",
    deploySha: "f".repeat(40),
    dedupKey: "f".repeat(40),
    title: "shopfront: 1 error regression after deploy fffffff (suspect: PR #812)",
    bodySections: [],
    labels: ["auto-vika"],
    regressionFingerprints: ["aaaaaaaaaaaa"],
    totalOccurrences: 124,
    suggestedAssignee: { name: "Tomas Ortega", email: "tomas@example.com", source: "author" },
    groups: [],
    assignmentFacts: { topSuspect: null, codeOwners: { emails: [], handles: [] } },
  };

  // A console that answers with the given lines and records what was shown.
  function makeConsole(isInteractive: boolean, answers: string[]): ApprovalConsole & { shown: string[]; questions: string[] } {
    const shown: string[] = [];
    const questions: string[] = [];
    return {
      isInteractive,
      shown,
      questions,
      write: (text) => shown.push(text),
      ask: async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      },
    };
  }

  // A createTicket stand-in that records which drafts it was asked to file.
  function makeFiler(): { filedDrafts: TicketDraft[]; fileTicket: (draft: TicketDraft) => Promise<CreateTicketOutcome> } {
    const filedDrafts: TicketDraft[] = [];
    return {
      filedDrafts,
      fileTicket: async (draft) => {
        filedDrafts.push(draft);
        return { status: "created", issueKey: "OPS-1", issueUrl: "https://example.atlassian.net/browse/OPS-1", assignee: draft.suggestedAssignee };
      },
    };
  }

  it('"y" creates the ticket, after showing title, assignee, top suspect and count', async () => {
    const approvalConsole = makeConsole(true, ["y"]);
    const filer = makeFiler();
    const results = await approveAndCreateTickets([DRAFT], approvalConsole, filer.fileTicket);
    expect(results.map((result) => result.decision)).toEqual(["approved"]);
    expect(filer.filedDrafts).toEqual([DRAFT]);
    expect(approvalConsole.questions).toEqual([APPROVAL_QUESTION]);
    const shownText = approvalConsole.shown.join("");
    expect(shownText).toContain(`Title:       ${DRAFT.title}`);
    expect(shownText).toContain("Assignee:    Tomas Ortega <tomas@example.com> (the suspect's author)");
    expect(shownText).toContain("Top suspect:");
    expect(shownText).toContain("Occurrences: 124 (log-derived)");
    expect(shownText).toContain("Created OPS-1: https://example.atlassian.net/browse/OPS-1");
  });

  it('"n" (and anything except y or e) skips', async () => {
    for (const answer of ["n", "", "yes please", "x"]) {
      const filer = makeFiler();
      const results = await approveAndCreateTickets([DRAFT], makeConsole(true, [answer]), filer.fileTicket);
      expect(results[0]!.decision).toBe("skipped");
      expect(filer.filedDrafts).toEqual([]);
    }
  });

  it('"e" edits the title, then creates the ticket with it', async () => {
    const approvalConsole = makeConsole(true, ["e", "Orders crash on discount codes after deploy fffffff"]);
    const filer = makeFiler();
    await approveAndCreateTickets([DRAFT], approvalConsole, filer.fileTicket);
    expect(approvalConsole.questions).toEqual([APPROVAL_QUESTION, "New title: "]);
    expect(filer.filedDrafts.map((draft) => draft.title)).toEqual(["Orders crash on discount codes after deploy fffffff"]);
  });

  it("without a terminal, nothing is ever created and nothing is asked", async () => {
    const approvalConsole = makeConsole(false, ["y"]);
    const filer = makeFiler();
    const results = await approveAndCreateTickets([DRAFT, DRAFT], approvalConsole, filer.fileTicket);
    expect(results.map((result) => result.decision)).toEqual(["not interactive", "not interactive"]);
    expect(filer.filedDrafts).toEqual([]);
    expect(approvalConsole.questions).toEqual([]);
    expect(approvalConsole.shown.join("")).toContain("approving tickets needs an interactive terminal");
  });

  it("report makes ZERO tracker calls without --create-tickets (and none without a terminal)", async () => {
    const project = await buildReportProject("direct", {
      trackerYamlLines: ["tracker:", "  type: jira", "  project: OPS"],
      extraEnvironment: { JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "ops@example.com", JIRA_API_TOKEN: "jira-token-Q7x9Lm2Pw4" },
    });
    projects.push(project);
    expect((await project.runVika(["report"])).exitCode).toBe(0);
    const withFlag = await project.runVika(["report", "--create-tickets"], { isInteractive: false });
    expect(withFlag.exitCode).toBe(0);
    expect(withFlag.output).toContain("1 ticket draft not filed: approving tickets needs an interactive terminal");
    expect(project.networkCalls).toEqual([]);
  }, 60_000);
});

describe("vika run", () => {
  const runProjects: ReportProject[] = [];
  afterAll(() => runProjects.forEach((project) => project.remove()));
  const startRunProject = async (options: Parameters<typeof buildReportProject>[1] = {}) => {
    const project = await buildReportProject("direct", options);
    runProjects.push(project);
    return project;
  };
  // The report part of the output (from the report's own first line on).
  const reportText = (output: string) => output.slice(output.indexOf("vika report - as of"));

  it("one service failing doesn't stop the others: it is listed, and the exit code is 1", async () => {
    const project = await startRunProject({
      extraServiceYamlLines: ["  broken:", "    repo: /does/not/exist", "    logs: /does/not/exist/app.log"],
    });
    const result = await project.runVika(["run"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("FAILED broken: services.broken.logs: cannot read /does/not/exist/app.log (ENOENT)");
    expect(result.output).toContain("== broken ==\nNote: failed: services.broken.logs: cannot read /does/not/exist/app.log (ENOENT)");
    // shopfront was still fully reported.
    expect(result.output).toMatch(/== shopfront ==[\s\S]*Regressions: 1/);
  }, 60_000);

  it("exit code 2 when another run holds a service's lock", async () => {
    const project = await startRunProject();
    const store = await openStore(readTestDatabaseUrl(), project.storeOptions);
    try {
      const lockResult = await store.withRunLock("shopfront", () => project.runVika(["run"]));
      if (lockResult === "busy") throw new Error("the test itself could not take the lock");
      expect(lockResult.exitCode).toBe(2);
      expect(lockResult.output).toContain('BUSY shopfront: skipped: another vika run is working on service "shopfront" right now');
    } finally {
      await store.close();
    }
  }, 60_000);

  it("running twice counts nothing twice and prints the same report", async () => {
    const project = await startRunProject();
    const store = await openStore(readTestDatabaseUrl(), project.storeOptions);
    try {
      const firstRun = await project.runVika(["run"]);
      const countsAfterFirstRun = await store.listClusterCounts("shopfront");
      const secondRun = await project.runVika(["run"]);
      expect(await store.listClusterCounts("shopfront")).toEqual(countsAfterFirstRun);
      expect([firstRun.exitCode, secondRun.exitCode]).toEqual([0, 0]);
      expect(secondRun.output).toContain("shopfront: read 0 new log lines");
      expect(reportText(secondRun.output)).toBe(reportText(firstRun.output));
    } finally {
      await store.close();
    }
  }, 60_000);

  it("--create-tickets without a terminal files nothing, says so, and asks nothing", async () => {
    const project = await startRunProject({
      trackerYamlLines: ["tracker:", "  type: jira", "  project: OPS"],
      extraEnvironment: { JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "ops@example.com", JIRA_API_TOKEN: "jira-token-Run4Cr0n" },
    });
    const result = await project.runVika(["run", "--create-tickets"], { isInteractive: false });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("1 ticket draft not filed: approving tickets needs an interactive terminal");
    expect(result.questions).toEqual([]);
    expect(project.networkCalls).toEqual([]);
  }, 60_000);
});
