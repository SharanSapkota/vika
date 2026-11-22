// Tests `vika doctor`: each FAIL and WARN case, the exit code, and that no
// secret ever reaches the output. Uses the fixture, temp folders, a fake
// tracker and the test database. Needs TEST_DATABASE_URL.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMarkDeployCommand } from "../src/commands/mark-deploy-command.js";
import { runCli } from "../src/commands/run-cli.js";
import { checkServiceLogs, LOG_FORMATS_README_FIX } from "../src/doctor/check-service-logs.js";
import { adviseOnPathMap } from "../src/doctor/suggest-path-map.js";
import { buildFixture, git, type Fixture } from "./fixture/build.js";
import { buildReportProject, makeTestSchemaName, readTestDatabaseUrl, type ReportProject, type ReportProjectOptions } from "./fixture/build-report-project.js";
import { buildSmallRepo, type SmallRepo } from "./fixture/build-small-repo.js";
import { createFakeJira, createFakeLinear, createForbiddenFetch } from "./fixture/fake-trackers.js";
import { REAL_PYTHON_LOG_SAMPLES } from "./fixture/python-log-samples.js";

const JIRA_TOKEN = "jira-token-Doc7Tr4Wq9";
const LINEAR_KEY = "lin_api_Doc3Xy8Zk1";
const JIRA_YAML = ["tracker:", "  type: jira", "  project: OPS"];
const JIRA_ENVIRONMENT = { JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "ops@example.com", JIRA_API_TOKEN: JIRA_TOKEN };

// The test database URL with one part changed (user, password, host, port, database).
function changeTestDatabaseUrl(change: (databaseUrl: URL) => void): string {
  const databaseUrl = new URL(readTestDatabaseUrl());
  change(databaseUrl);
  return databaseUrl.toString();
}

// The lines of doctor's output at one level ("OK", "WARN", "FAIL").
const linesAt = (output: string, level: string) => output.split("\n").filter((line) => line.startsWith(`${level.padEnd(4)} `));

describe("vika doctor", () => {
  let fixture: Fixture;
  const projects: ReportProject[] = [];
  const temporaryFolders: string[] = [];
  const smallRepos: SmallRepo[] = [];

  beforeAll(() => {
    fixture = buildFixture("direct");
  }, 60_000);
  afterAll(() => {
    projects.forEach((project) => project.remove());
    temporaryFolders.forEach((folder) => rmSync(folder, { recursive: true, force: true }));
    smallRepos.forEach((repo) => rmSync(repo.root, { recursive: true, force: true }));
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const startProject = async (options: ReportProjectOptions = {}) => {
    const project = await buildReportProject("direct", { fixture, trackerYamlLines: JIRA_YAML, extraEnvironment: JIRA_ENVIRONMENT, ...options });
    projects.push(project);
    return project;
  };
  const makeFolder = () => {
    const folder = mkdtempSync(join(tmpdir(), "vika-doctor-"));
    temporaryFolders.push(folder);
    return folder;
  };
  const runDoctor = (project: ReportProject, session: Parameters<ReportProject["runVika"]>[1] = {}) =>
    project.runVika(["doctor"], { fetchFunction: createFakeJira().fetchFunction, ...session });

  it("a healthy project: everything OK, exit code 0", async () => {
    const project = await startProject();
    const result = await runDoctor(project);
    expect(result.exitCode).toBe(0);
    expect(linesAt(result.output, "FAIL")).toEqual([]);
    expect(linesAt(result.output, "WARN")).toEqual([]);
    expect(result.output).toContain("OK   database: all 5 migrations applied");
    expect(result.output).toContain("OK   service shopfront: logs: stack-trace paths match files in the repo");
    expect(result.output).toMatch(/OK {3}service shopfront: logs: format: text \(guessed; \d+ of the first 200 lines recognized\), language: javascript/);
    expect(result.output).toContain("OK   service shopfront: deploys: 5 deploys recorded with mark-deploy");
    expect(result.output).toContain("OK   tracker: Jira accepts the credentials (logged in as vika bot)");
    expect(result.output).toContain("All set.");
  }, 60_000);

  it("FAIL: no vika.yaml (says where it looked), and an invalid one", async () => {
    const run = async (folder: string) => {
      let output = "";
      const exitCode = await runCli(["doctor"], {
        writeOutput: (text) => (output += text),
        writeError: () => {},
        isOutputTerminal: false,
        isInputTerminal: false,
        ask: async () => "",
        fetchFunction: createForbiddenFetch([]),
        environment: { DATABASE_URL: readTestDatabaseUrl() },
        workingDirectory: folder,
        clock: () => new Date(0),
      });
      return { exitCode, output };
    };
    const emptyFolder = makeFolder();
    const missing = await run(emptyFolder);
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain(`FAIL configuration: Configuration file not found: looked for ${join(emptyFolder, "vika.yaml")}`);
    expect(missing.output).toContain("fix: run `vika init` in your project folder");

    const invalidFolder = makeFolder();
    writeFileSync(join(invalidFolder, "vika.yaml"), "tracker:\n  type: none\n");
    const invalid = await run(invalidFolder);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.output).toContain("FAIL configuration: Problems in");
    expect(invalid.output).toContain("services is missing");
  });

  it("FAIL: DATABASE_URL and the Jira variables missing, each under its own area", async () => {
    const project = await startProject();
    const result = await runDoctor(project, { environment: { DATABASE_URL: "", JIRA_API_TOKEN: "" } });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("FAIL database: Missing environment variables: DATABASE_URL is not set (put it in .env)");
    expect(result.output).toContain('FAIL tracker: Missing environment variables: JIRA_API_TOKEN is not set (put it in .env; needed because tracker.type is "jira")');
  }, 60_000);

  it("FAIL: unreachable host, wrong password and missing database are told apart, never showing the password", async () => {
    const project = await startProject();
    const cases = [
      { secret: "Unreach-Secret-71", expected: "FAIL database: cannot reach the database host", change: (url: URL) => ((url.hostname = "127.0.0.1"), (url.port = "1")) },
      { secret: "Wrong-Secret-22", expected: "FAIL database: the database refused the login (wrong user or password)", change: () => {} },
      { secret: null, expected: 'FAIL database: the server answered, but database "no_such_database_vika" does not exist', change: (url: URL) => (url.pathname = "/no_such_database_vika") },
    ];
    for (const testCase of cases) {
      const databaseUrl = changeTestDatabaseUrl((url) => {
        testCase.change(url);
        if (testCase.secret !== null) url.password = testCase.secret;
      });
      const result = await runDoctor(project, { environment: { DATABASE_URL: databaseUrl } });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(testCase.expected);
      if (testCase.secret !== null) expect(result.output + result.errorOutput).not.toContain(testCase.secret);
      expect(result.output + result.errorOutput).not.toContain(databaseUrl);
    }
  }, 60_000);

  it("WARN: pending migrations, a pooler host, and no sslmode on a remote host", async () => {
    const project = await startProject();
    const freshSchema = await runDoctor(project, { storeOptions: { schema: makeTestSchemaName() } });
    expect(freshSchema.output).toContain("WARN database: 5 migrations not applied yet: 001_init, 002_bookmark_history_start, 003_tickets, 004_ticket_comment_count, 005_webhook_events");
    expect(freshSchema.output).toContain("they are applied automatically when `vika report` or `vika run` starts");

    const poolerUrl = "postgres://vika:Pooler-Secret-55@ep-quiet-lake-123-pooler.example.invalid/vika";
    const pooler = await runDoctor(project, { environment: { DATABASE_URL: poolerUrl } });
    const warnings = linesAt(pooler.output, "WARN").join("\n");
    expect(warnings).toContain('"-pooler" in the host');
    expect(warnings).toContain("has no sslmode");
    expect(pooler.output).not.toContain("Pooler-Secret-55");
  }, 60_000);

  it("repo: FAIL for a folder that isn't a git repo or a missing branch, WARN for a checkout on another branch", async () => {
    const notARepo = makeFolder();
    const offBranchRepo = buildSmallRepo();
    smallRepos.push(offBranchRepo);
    const author = { name: "Alice Novak", email: "alice@example.com" };
    offBranchRepo.commit({ "a.txt": "a\n" }, { message: "first", author, time: "2026-04-01T09:00:00Z" });
    git(offBranchRepo.repoPath, ["checkout", "-q", "-b", "experiment"]);
    offBranchRepo.commit({ "a.txt": "b\n" }, { message: "on a side branch", author, time: "2026-04-02T09:00:00Z" });

    const project = await startProject({
      extraServiceYamlLines: [
        "  not-a-repo:",
        `    repo: ${JSON.stringify(notARepo)}`,
        `    logs: ${JSON.stringify(fixture.logPath)}`,
        "  no-such-branch:",
        `    repo: ${JSON.stringify(fixture.repoDir)}`,
        `    logs: ${JSON.stringify(fixture.logPath)}`,
        "    branch: release",
        "  side-checkout:",
        `    repo: ${JSON.stringify(offBranchRepo.repoPath)}`,
        `    logs: ${JSON.stringify(fixture.logPath)}`,
      ],
    });
    const result = await runDoctor(project);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`FAIL service not-a-repo: repo: ${notARepo} is not a git repository`);
    expect(result.output).toContain(`FAIL service no-such-branch: repo: branch "release" does not exist in ${fixture.repoDir}`);
    expect(result.output).toMatch(/WARN service side-checkout: repo: the checkout \(HEAD [0-9a-f]{7}\) is not on "main"/);
    expect(result.output).toContain('vika always reads "main", not the checkout');
  }, 60_000);

  it("repo: FAIL when the latest stored deploy is not in the repo", async () => {
    const project = await startProject();
    await runMarkDeployCommand({
      workingDirectory: project.folder,
      environment: project.environment,
      storeOptions: project.storeOptions,
      serviceName: "shopfront",
      sha: "e".repeat(40),
      time: "2026-03-10T12:00:00Z",
      clock: () => new Date(0),
    });
    const result = await runDoctor(project);
    expect(result.output).toContain(`FAIL service shopfront: repo: the latest stored deploy: commit ${"e".repeat(40)} does not exist in ${fixture.repoDir}`);
  }, 60_000);

  it("logs: FAIL for a missing file, a failing command and an unknown format; OK for a working command", async () => {
    const folder = makeFolder();
    const junkLog = join(folder, "junk.log");
    writeFileSync(junkLog, "hello there\nnothing like a log line\n");
    const project = await startProject({
      extraServiceYamlLines: [
        "  missing-file:",
        `    repo: ${JSON.stringify(fixture.repoDir)}`,
        `    logs: ${JSON.stringify(join(folder, "nope.log"))}`,
        "  failing-command:",
        `    repo: ${JSON.stringify(fixture.repoDir)}`,
        "    logs:",
        "      command: exit 3",
        "  unknown-format:",
        `    repo: ${JSON.stringify(fixture.repoDir)}`,
        `    logs: ${JSON.stringify(junkLog)}`,
        "  working-command:",
        `    repo: ${JSON.stringify(fixture.repoDir)}`,
        "    logs:",
        `      command: head -n 40 ${JSON.stringify(fixture.logPath)}`,
      ],
    });
    const result = await runDoctor(project);
    expect(result.output).toContain(`FAIL service missing-file: logs: ${join(folder, "nope.log")} does not exist`);
    expect(result.output).toContain("FAIL service failing-command: logs: the log command exited with code 3");
    expect(result.output).toContain(
      "FAIL service unknown-format: logs: none of the first 2 lines is in a format vika knows (text, json, nginx; logFormat can be auto, text, json or nginx; language can be javascript or python)",
    );
    expect(result.output).toContain(`fix: ${LOG_FORMATS_README_FIX}`);
    expect(result.output).toContain("OK   service working-command: logs: the log command ran and printed 40 lines");
  }, 60_000);

  it("logs: a Python service shows its language and format; tracebacks match the repo; library frames are ignored", async () => {
    const pythonFixture = buildFixture("python-indirect");
    try {
      const project = await buildReportProject("python-indirect", { fixture: pythonFixture, trackerYamlLines: JIRA_YAML, extraEnvironment: JIRA_ENVIRONMENT });
      projects.push(project);
      const result = await runDoctor(project);
      expect(linesAt(result.output, "FAIL")).toEqual([]);
      expect(linesAt(result.output, "WARN")).toEqual([]);
      expect(result.output).toMatch(/OK {3}service shopfront: logs: format: text \(guessed; \d+ of the first 200 lines recognized\), language: python/);
      expect(result.output).toContain("OK   service shopfront: logs: stack-trace paths match files in the repo");
    } finally {
      rmSync(pythonFixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("logs: a logFormat that does not match the log FAILs and names the allowed values", async () => {
    const project = await startProject({ extraServiceYamlLines: ["  set-format:", `    repo: ${JSON.stringify(fixture.repoDir)}`, `    logs: ${JSON.stringify(fixture.logPath)}`, "    logFormat: json"] });
    const result = await runDoctor(project);
    expect(result.output).toContain(
      'FAIL service set-format: logs: none of the first 200 lines is in the "json" format set by logFormat (logFormat can be auto, text, json or nginx; language can be javascript or python)',
    );
  }, 60_000);

  it("logs: the real Python samples are recognized as the text format", async () => {
    const folder = makeFolder();
    const logPath = join(folder, "python.log");
    writeFileSync(logPath, REAL_PYTHON_LOG_SAMPLES.join("\n") + "\n");
    const checks = await checkServiceLogs({ serviceName: "api", logs: logPath, configurationDirectory: folder, pathMap: undefined, doesRepoFileExist: undefined, language: "python" });
    expect(checks.map((check) => `${check.level} ${check.message}`)).toEqual([
      `OK ${logPath} is readable`,
      "OK format: text (guessed; 5 of the first 7 lines recognized), language: python",
    ]);
    const setFormatChecks = await checkServiceLogs({ serviceName: "api", logs: logPath, configurationDirectory: folder, pathMap: undefined, doesRepoFileExist: undefined, language: "python", logFormat: "text" });
    expect(setFormatChecks[1]!.message).toBe("format: text (set by logFormat; 5 of the first 7 lines recognized), language: python");
  });

  it("adviseOnPathMap ignores Python site-packages, dist-packages and standard-library frames", async () => {
    const exists = async (repoPath: string) => repoPath === "src/shop/orders/service.py";
    expect(
      await adviseOnPathMap(
        ["/usr/local/lib/python3.12/site-packages/fastapi/routing.py", "/usr/lib/python3/dist-packages/requests/api.py", "/usr/local/lib/python3.12/asyncio/tasks.py"],
        undefined,
        exists,
      ),
    ).toEqual({ kind: "no stack traces" });
    expect(await adviseOnPathMap(["/usr/local/lib/python3.12/site-packages/fastapi/routing.py", "/app/src/shop/orders/service.py"], undefined, exists)).toMatchObject({
      kind: "suggestion",
      serverPrefix: "/app/src",
      repoPrefix: "src",
    });
  });

  it("logs: WARN with the exact pathMap to add when stack-trace paths aren't in the repo", async () => {
    const project = await startProject({ isPathMapIncluded: false });
    const result = await runDoctor(project);
    expect(result.output).toContain("WARN service shopfront: logs: stack-trace paths like /app/src/orders/service.ts are not in the repo");
    expect(result.output).toContain('fix: add to services.shopfront in vika.yaml:  pathMap: { "/app/src": "src" }');
  }, 60_000);

  it("adviseOnPathMap: drops server folders until the path exists; ignores library frames", async () => {
    const repoFiles = new Set(["src/orders/service.ts", "server.js"]);
    const exists = async (repoPath: string) => repoFiles.has(repoPath);
    expect(await adviseOnPathMap(["/srv/app/src/orders/service.ts"], undefined, exists)).toEqual({
      kind: "suggestion",
      serverPrefix: "/srv/app/src",
      repoPrefix: "src",
      examplePath: "/srv/app/src/orders/service.ts",
    });
    expect(await adviseOnPathMap(["/srv/app/server.js"], undefined, exists)).toMatchObject({ serverPrefix: "/srv/app", repoPrefix: "" });
    expect(await adviseOnPathMap(["/app/node_modules/express/lib/router.js", "node:internal/process"], undefined, exists)).toEqual({ kind: "no stack traces" });
    expect(await adviseOnPathMap(["/app/src/orders/service.ts"], { "/app/src": "src" }, exists)).toEqual({ kind: "paths found", checkedCount: 1 });
  });

  it("deploys: WARN with the exact mark-deploy command when marker has none; WARN that merges is rough", async () => {
    const noDeploys = await runDoctor(await startProject({ shouldMarkDeploys: false }));
    expect(noDeploys.output).toContain("WARN service shopfront: deploys: deploys.source is marker, but no deploy has been recorded yet");
    expect(noDeploys.output).toContain('fix: add this to the end of your deploy script: vika mark-deploy --service shopfront --sha "$(git rev-parse HEAD)" --time "$(date -u +%Y-%m-%dT%H:%M:%SZ)"');

    const merges = await runDoctor(await startProject({ deploySource: "merges" }));
    expect(merges.output).toContain('WARN service shopfront: deploys: deploys.source is merges: every commit on "main" counts as a deploy at its commit time. That is rough');
  }, 60_000);

  it("tracker: a 401 is a plain FAIL without the token; Linear credentials are checked with viewer", async () => {
    const project = await startProject();
    const rejected = await runDoctor(project, {
      fetchFunction: createFakeJira([], { failWithStatus: 401, failureBody: JSON.stringify({ errorMessages: [`bad token ${JIRA_TOKEN}`] }) }).fetchFunction,
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.output).toContain("FAIL tracker: Jira rejected vika's credentials (HTTP 401). Check JIRA_EMAIL and JIRA_API_TOKEN.");
    expect(rejected.output + rejected.errorOutput).not.toContain(JIRA_TOKEN);

    const linearProject = await startProject({ trackerYamlLines: ["tracker:", "  type: linear", "  team: ENG"], extraEnvironment: { LINEAR_API_KEY: LINEAR_KEY } });
    const fakeLinear = createFakeLinear();
    const linear = await runDoctor(linearProject, { fetchFunction: fakeLinear.fetchFunction });
    expect(linear.output).toContain("OK   tracker: Linear accepts the credentials (logged in as vika bot)");
    expect(JSON.stringify(fakeLinear.requests[0]!.body)).toContain("viewer");
    expect(linear.output).not.toContain(LINEAR_KEY);
  }, 60_000);
});

describe("vika doctor: webhook", () => {
  let fixture: Fixture;
  const projects: ReportProject[] = [];
  beforeAll(() => {
    fixture = buildFixture("direct");
  }, 60_000);
  afterAll(() => {
    projects.forEach((project) => project.remove());
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("OK for a valid URL (showing only its host), WARN when bodies are not signed", async () => {
    const project = await buildReportProject("direct", { fixture, trackerYamlLines: ["webhook:", "  url: https://hooks.example.com/services/T0K3N"] });
    projects.push(project);
    const result = await project.runVika(["doctor"]);
    expect(result.output).toContain("OK   webhook: webhook URL on hooks.example.com is valid");
    expect(result.output).toContain("WARN webhook: no VIKA_WEBHOOK_SECRET is set, so webhook bodies are not signed");
    expect(result.output).not.toContain("T0K3N");
  }, 60_000);

  it("FAIL for a plain-http URL that isn't localhost", async () => {
    // Added after setup: with it, setting the project up (mark-deploy) would rightly fail.
    const project = await buildReportProject("direct", { fixture });
    projects.push(project);
    appendFileSync(join(project.folder, "vika.yaml"), "webhook:\n  url: http://hooks.example.com/vika\n");
    const result = await project.runVika(["doctor"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("FAIL webhook: Problems in");
    expect(result.output).toContain("webhook.url must use https (plain http is only allowed for localhost)");
  }, 60_000);
});
