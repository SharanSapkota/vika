// Tests suspect attribution: the two fixture scenarios (where the right answer
// is known), small temp repos for each special case, and the read-only and
// determinism guarantees. No Postgres.
import { readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCommitsInRange } from "../src/deploys/commits-in-range.js";
import { buildClusters } from "../src/error-grouping/build-clusters.js";
import type { Frame } from "../src/log-parsing/log-entry-types.js";
import { parseLines } from "../src/log-parsing/parse-log-lines.js";
import { applyPathMap } from "../src/suspect-attribution/apply-path-map.js";
import { attributeRegression, FIRST_DEPLOY_MESSAGE } from "../src/suspect-attribution/attribute-regression.js";
import { blameLine } from "../src/suspect-attribution/git-blame-reader.js";
import { isPythonLibraryFrame } from "../src/suspect-attribution/library-frames.js";
import { findModuleFilePaths, findPythonCalleeLocation } from "../src/suspect-attribution/python-callee-files.js";
import { findPythonCrashLineInputs } from "../src/suspect-attribution/python-crash-line-inputs.js";
import { findPythonFunctionDefinitionLine, findPythonFunctionLineRange, readPythonFunctionName } from "../src/suspect-attribution/python-function-names.js";
import { NO_STRONG_SUSPECT_MESSAGE } from "../src/suspect-attribution/score-suspects.js";
import type { AttributionResult, PathMap } from "../src/suspect-attribution/suspect-types.js";
import { buildFixture, git, SCENARIOS, type Fixture, type Scenario } from "./fixture/build.js";
import { buildSmallRepo, type Person, type SmallRepo } from "./fixture/build-small-repo.js";

// The fixture's stack traces say /app/src/...; the repo has src/...
const APP_PATH_MAP: PathMap = { "/app/src": "src" };

const ALICE: Person = { name: "Alice Novak", email: "alice@example.com" };
const BOB: Person = { name: "Bob Lindqvist", email: "bob@example.com" };
const DEPENDABOT: Person = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };

// The new error's top frames, the way the real pipeline produces them.
function readNewErrorFrames(fixture: Fixture): Frame[] {
  const { entries } = parseLines(readFileSync(fixture.logPath, "utf8").split("\n"), undefined, undefined, fixture.expected.language);
  const newErrorCluster = buildClusters(entries, "shopfront").clusters.find((cluster) => cluster.firstSeen === fixture.expected.errorFirstSeen);
  if (!newErrorCluster) throw new Error("fixture has no cluster for the seeded bug");
  return newErrorCluster.topFrames;
}

// The file that crashes in each fixture app.
const crashFilePath = (fixture: Fixture) => (fixture.expected.language === "python" ? "src/shop/orders/service.py" : "src/orders/service.ts");

async function attributeFixture(fixture: Fixture, pathMap: PathMap | null = APP_PATH_MAP): Promise<AttributionResult> {
  // null = no path map (undefined would pick the default above).
  const { badDeploySha, previousSha } = fixture.expected;
  return attributeRegression({
    repoPath: fixture.repoDir,
    deploySha: badDeploySha,
    previousSha,
    topFrames: readNewErrorFrames(fixture),
    ...(pathMap ? { pathMap } : {}),
    language: fixture.expected.language,
    commitsInRange: await listCommitsInRange(fixture.repoDir, previousSha, badDeploySha),
  });
}

// Everything that would show a write to the repo: HEAD, every ref, the
// working tree and index, and the stash.
function snapshotRepoState(repoPath: string): string {
  return [
    git(repoPath, ["rev-parse", "HEAD"]),
    git(repoPath, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    git(repoPath, ["status", "--porcelain", "--untracked-files=all"]),
    git(repoPath, ["stash", "list"]),
  ].join("\n---\n");
}

describe("suspect attribution on the fixture", () => {
  const fixtures = {} as Record<Scenario, Fixture>;

  beforeAll(() => {
    for (const scenario of SCENARIOS) fixtures[scenario] = buildFixture(scenario);
  }, 120_000);

  afterAll(() => {
    for (const fixture of Object.values(fixtures)) rmSync(fixture.root, { recursive: true, force: true });
  });

  it("direct: the top suspect is the seeded commit, high confidence, on the blamed line", async () => {
    const fixture = fixtures.direct;
    const { expected } = fixture;
    const result = await attributeFixture(fixture);

    // The line that throws, read from the repo at the bad deploy.
    const serviceLines = git(fixture.repoDir, ["show", `${expected.badDeploySha}:src/orders/service.ts`]).split("\n");
    const failingLineIndex = serviceLines.findIndex((line) => line.includes("order.discount.amount"));

    expect(result.message).toBeNull();
    expect(result.suspects[0]).toEqual({
      commitSha: expected.suspectSha,
      prNumber: expected.suspectPr,
      confidence: "high",
      evidenceKind: "blamed-line-changed",
      reason: expect.any(String),
      filePath: "src/orders/service.ts",
      lineNumber: failingLineIndex + 1,
      lineText: serviceLines[failingLineIndex],
      author: { name: expected.suspectAuthor, email: expected.suspectEmail },
      isInDeployRange: true,
      isBot: false,
    });
    expect(result.suspects.length).toBeLessThanOrEqual(3);
  });

  it("indirect: blame points outside the range, yet the top suspect is the seeded commit", async () => {
    const fixture = fixtures.indirect;
    const { expected } = fixture;
    const topFrame = readNewErrorFrames(fixture)[0]!;
    const commitsInRange = await listCommitsInRange(fixture.repoDir, expected.previousSha, expected.badDeploySha);

    // The failing line ("const email = user.email;") is older than the deploy.
    const blamedLine = await blameLine(fixture.repoDir, expected.badDeploySha, "src/orders/service.ts", topFrame.line, []);
    expect(commitsInRange.map((commit) => commit.sha)).not.toContain(blamedLine.commitSha);

    const result = await attributeFixture(fixture);
    expect(result.suspects[0]).toMatchObject({
      commitSha: expected.suspectSha,
      prNumber: expected.suspectPr,
      confidence: "high",
      evidenceKind: "call-chain-function-changed",
      filePath: "src/users/repo.ts",
      author: { name: expected.suspectAuthor, email: expected.suspectEmail },
    });
    // The commit that only added a log line to the same function ranks below.
    expect(result.suspects[1]).toMatchObject({ evidenceKind: "same-function-changed", confidence: "medium" });
  });

  it("python-direct: the top suspect is the seeded commit, high confidence, on the blamed line", async () => {
    const fixture = fixtures["python-direct"];
    const { expected } = fixture;
    const result = await attributeFixture(fixture);

    const serviceLines = git(fixture.repoDir, ["show", `${expected.badDeploySha}:src/shop/orders/service.py`]).split("\n");
    const failingLineIndex = serviceLines.findIndex((line) => line.includes('order["discount"]["amount"]'));

    expect(result.message).toBeNull();
    expect(result.suspects[0]).toEqual({
      commitSha: expected.suspectSha,
      prNumber: expected.suspectPr,
      confidence: "high",
      evidenceKind: "blamed-line-changed",
      reason: expect.any(String),
      filePath: "src/shop/orders/service.py",
      lineNumber: failingLineIndex + 1,
      lineText: serviceLines[failingLineIndex],
      author: { name: expected.suspectAuthor, email: expected.suspectEmail },
      isInDeployRange: true,
      isBot: false,
    });
    // The library frame (fastapi in site-packages) is in the top 3 frames but
    // never becomes evidence.
    expect(readNewErrorFrames(fixture).map((frame) => frame.file)).toContain("/usr/local/lib/python3.12/site-packages/fastapi/routing.py");
    expect(result.suspects.every((suspect) => !suspect.filePath.includes("site-packages"))).toBe(true);
  });

  it("python-indirect: blame points outside the range, yet the top suspect is the seeded commit", async () => {
    const fixture = fixtures["python-indirect"];
    const { expected } = fixture;
    const topFrame = readNewErrorFrames(fixture)[0]!;
    const commitsInRange = await listCommitsInRange(fixture.repoDir, expected.previousSha, expected.badDeploySha);

    // The failing line ("email = user.email") is older than the deploy.
    const blamedLine = await blameLine(fixture.repoDir, expected.badDeploySha, "src/shop/orders/service.py", topFrame.line, []);
    expect(blamedLine.lineText.trim()).toBe("email = user.email");
    expect(commitsInRange.map((commit) => commit.sha)).not.toContain(blamedLine.commitSha);

    const result = await attributeFixture(fixture);
    expect(result.suspects.map((suspect) => suspect.commitSha)).not.toContain(blamedLine.commitSha);
    expect(result.suspects[0]).toMatchObject({
      commitSha: expected.suspectSha,
      prNumber: expected.suspectPr,
      confidence: "high",
      evidenceKind: "call-chain-function-changed",
      filePath: "src/shop/users/repo.py",
      lineText: "def get_user(user_id: str) -> User | None:",
      author: { name: expected.suspectAuthor, email: expected.suspectEmail },
    });
    // The commit that only added a log line to create_order (a method inside
    // a class) ranks below.
    expect(result.suspects[1]).toMatchObject({ evidenceKind: "same-function-changed", confidence: "medium", filePath: "src/shop/orders/service.py" });
  });

  it("a blamed commit outside the range is never a suspect, let alone high", async () => {
    const fixture = fixtures.indirect;
    const topFrame = readNewErrorFrames(fixture)[0]!;
    const blamedLine = await blameLine(fixture.repoDir, fixture.expected.badDeploySha, "src/orders/service.ts", topFrame.line, []);
    const result = await attributeFixture(fixture);
    expect(result.suspects.map((suspect) => suspect.commitSha)).not.toContain(blamedLine.commitSha);
    expect(result.suspects.every((suspect) => suspect.evidenceKind !== "blamed-line-changed")).toBe(true);
  });

  it("pathMap /app/src -> src makes blame work", async () => {
    const fixture = fixtures.direct;
    // Without it, the frames' absolute paths aren't in the repo: no evidence.
    const withoutPathMap = await attributeFixture(fixture, null);
    expect(withoutPathMap).toEqual({ suspects: [], message: NO_STRONG_SUSPECT_MESSAGE });

    const withPathMap = await attributeFixture(fixture, APP_PATH_MAP);
    expect(withPathMap.suspects[0]).toMatchObject({ evidenceKind: "blamed-line-changed", filePath: "src/orders/service.ts" });
  });

  it("previousSha null gives no suspects", async () => {
    const fixture = fixtures.direct;
    const result = await attributeRegression({
      repoPath: fixture.repoDir,
      deploySha: fixture.deploys[0]!.sha,
      previousSha: null,
      topFrames: readNewErrorFrames(fixture),
      pathMap: APP_PATH_MAP,
      commitsInRange: [],
    });
    expect(result).toEqual({ suspects: [], message: FIRST_DEPLOY_MESSAGE });
  });

  it("is deterministic: the same input gives identical output", async () => {
    for (const fixture of Object.values(fixtures)) {
      const firstRun = await attributeFixture(fixture);
      const secondRun = await attributeFixture(fixture);
      expect(JSON.stringify(secondRun)).toBe(JSON.stringify(firstRun));
    }
  });

  it("is read-only: HEAD, refs, the working tree and the stash are unchanged", async () => {
    for (const fixture of Object.values(fixtures)) {
      const before = snapshotRepoState(fixture.repoDir);
      await attributeFixture(fixture);
      await attributeFixture(fixture, null);
      await blameLine(fixture.repoDir, fixture.expected.badDeploySha, crashFilePath(fixture), 1, []);
      expect(snapshotRepoState(fixture.repoDir)).toBe(before);
    }
  });

  it("names the right top suspect for every seeded bug", async () => {
    const scenarios: readonly Scenario[] = SCENARIOS;
    let correctCount = 0;
    for (const scenario of scenarios) {
      const result = await attributeFixture(fixtures[scenario]);
      if (result.suspects[0]?.commitSha === fixtures[scenario].expected.suspectSha) correctCount++;
    }
    console.log(`correct top suspect in ${correctCount} of ${scenarios.length} seeded bugs`);
    expect(correctCount).toBe(scenarios.length);
  });
});

// ---------------------------------------------------------------------------
// Small temp repos, one special case each
// ---------------------------------------------------------------------------

const APP_SOURCE = [
  "// Reads the server settings.",
  "export function loadSettings(raw: string): { port: number } {",
  "  const parsed = JSON.parse(raw);",
  '  return { port: parsed["server"].port };',
  "}",
  "",
].join("\n");
// The frame of an error thrown on the "return" line (line 4) of loadSettings.
const LOAD_SETTINGS_FRAME: Frame = { file: "src/settings.ts", line: 4, fn: "loadSettings" };

// A repo with one starting commit (the "previous deploy") by Alice.
function buildBaseRepo(): { repo: SmallRepo; previousSha: string } {
  const repo = buildSmallRepo();
  const previousSha = repo.commit(
    {
      "src/settings.ts": APP_SOURCE,
      "src/other.ts": "export const other = 1;\n",
      "package-lock.json": '{ "lockfileVersion": 3, "packages": { "node_modules/left-pad": { "version": "1.0.0" } } }\n',
      "config/settings.yaml": "port: 8080\n",
    },
    { message: "Initial commit (#1)", author: ALICE, time: "2026-04-01T09:00:00Z" },
  );
  return { repo, previousSha };
}

async function attributeSmallRepo(repo: SmallRepo, previousSha: string, deploySha: string, topFrames: Frame[]): Promise<AttributionResult> {
  return attributeRegression({
    repoPath: repo.repoPath,
    deploySha,
    previousSha,
    topFrames,
    commitsInRange: await listCommitsInRange(repo.repoPath, previousSha, deploySha),
  });
}

describe("suspect attribution on small temp repos", () => {
  const repos: SmallRepo[] = [];
  const startRepo = () => {
    const base = buildBaseRepo();
    repos.push(base.repo);
    return base;
  };

  afterAll(() => {
    for (const repo of repos) rmSync(repo.root, { recursive: true, force: true });
  });

  it("flags a lockfile bump as a dependency-or-config candidate", async () => {
    const { repo, previousSha } = startRepo();
    const bumpSha = repo.commit(
      { "package-lock.json": '{ "lockfileVersion": 3, "packages": { "node_modules/left-pad": { "version": "2.0.0" } } }\n' },
      { message: "Bump left-pad to 2.0.0 (#2)", author: BOB, time: "2026-04-02T09:00:00Z" },
    );
    const result = await attributeSmallRepo(repo, previousSha, bumpSha, [LOAD_SETTINGS_FRAME]);
    expect(result.suspects[0]).toMatchObject({
      commitSha: bumpSha,
      prNumber: 2,
      evidenceKind: "dependency-or-config-change",
      confidence: "medium",
      filePath: "package-lock.json",
      lineNumber: null,
    });
    expect(result.suspects[0]!.reason).toContain("lockfile");
  });

  it("flags a config-only change as a dependency-or-config candidate", async () => {
    const { repo, previousSha } = startRepo();
    const configSha = repo.commit(
      { "config/settings.yaml": "port: 9090\n" },
      { message: "Move to port 9090 (#3)", author: BOB, time: "2026-04-02T09:00:00Z" },
    );
    const result = await attributeSmallRepo(repo, previousSha, configSha, [LOAD_SETTINGS_FRAME]);
    expect(result.suspects).toHaveLength(1);
    expect(result.suspects[0]).toMatchObject({ commitSha: configSha, evidenceKind: "dependency-or-config-change", filePath: "config/settings.yaml" });
    expect(result.suspects[0]!.reason).toContain("config file");
  });

  it("a stack trace with no frames gives no strong suspect", async () => {
    const { repo, previousSha } = startRepo();
    const codeSha = repo.commit(
      { "src/other.ts": "export const other = 2;\n" },
      { message: "Change other (#4)", author: BOB, time: "2026-04-02T09:00:00Z" },
    );
    const result = await attributeSmallRepo(repo, previousSha, codeSha, []);
    expect(result).toEqual({ suspects: [], message: NO_STRONG_SUSPECT_MESSAGE });
  });

  it("a blamed commit outside the range is never high", async () => {
    const { repo, previousSha } = startRepo();
    // The deploy only adds a new function to the same file; the failing line
    // was written before the deploy.
    const addFunctionSha = repo.commit(
      { "src/settings.ts": `${APP_SOURCE}export function describeSettings(): string {\n  return "settings";\n}\n` },
      { message: "Add describeSettings (#5)", author: BOB, time: "2026-04-02T09:00:00Z" },
    );
    const result = await attributeSmallRepo(repo, previousSha, addFunctionSha, [LOAD_SETTINGS_FRAME]);
    expect(result.suspects.map((suspect) => suspect.commitSha)).not.toContain(previousSha);
    expect(result.suspects.some((suspect) => suspect.confidence === "high")).toBe(false);
    expect(result.suspects[0]).toMatchObject({ commitSha: addFunctionSha, evidenceKind: "file-changed" });
  });

  it("marks a bot author with isBot true, and still lists it", async () => {
    const { repo, previousSha } = startRepo();
    const botSha = repo.commit(
      { "src/settings.ts": APP_SOURCE.replace('parsed["server"].port', 'parsed["server"].port ?? 80') },
      { message: "Default the port (#6)", author: DEPENDABOT, time: "2026-04-02T09:00:00Z" },
    );
    const result = await attributeSmallRepo(repo, previousSha, botSha, [LOAD_SETTINGS_FRAME]);
    expect(result.suspects[0]).toMatchObject({
      commitSha: botSha,
      confidence: "high",
      evidenceKind: "blamed-line-changed",
      isBot: true,
      author: { name: DEPENDABOT.name, email: DEPENDABOT.email },
    });
  });

  it("uses the author, not the committer", async () => {
    const { repo, previousSha } = startRepo();
    // Bob wrote the change; Alice committed it (e.g. she rebased or merged it).
    const changeSha = repo.commit(
      { "src/settings.ts": APP_SOURCE.replace('parsed["server"].port', 'parsed["server"].port + 0') },
      { message: "Coerce the port (#7)", author: BOB, committer: ALICE, time: "2026-04-02T09:00:00Z" },
    );
    expect(git(repo.repoPath, ["log", "-1", "--format=%an|%cn", changeSha])).toBe(`${BOB.name}|${ALICE.name}`);
    const result = await attributeSmallRepo(repo, previousSha, changeSha, [LOAD_SETTINGS_FRAME]);
    expect(result.suspects[0]).toMatchObject({ commitSha: changeSha, author: { name: BOB.name, email: BOB.email } });
  });

  it("respects .git-blame-ignore-revs at the deployed sha", async () => {
    const { repo, previousSha } = startRepo();
    // A style-only commit rewrites the failing line, then is listed as ignored.
    const styleSha = repo.commit(
      { "src/settings.ts": APP_SOURCE.replace('parsed["server"].port', "parsed.server.port") },
      { message: "Use dot access everywhere (#8)", author: BOB, time: "2026-04-02T09:00:00Z" },
    );
    const ignoreFileSha = repo.commit(
      { ".git-blame-ignore-revs": `# style-only changes\n${styleSha}\n` },
      { message: "Ignore the style commit in blame (#9)", author: BOB, time: "2026-04-02T10:00:00Z" },
    );
    const result = await attributeSmallRepo(repo, previousSha, ignoreFileSha, [LOAD_SETTINGS_FRAME]);
    // Blame looks past the style commit to Alice's original line (outside
    // the range), so the style commit is not a blamed-line suspect.
    expect(result.suspects.some((suspect) => suspect.evidenceKind === "blamed-line-changed")).toBe(false);
    expect(result.suspects[0]).toMatchObject({ commitSha: styleSha, evidenceKind: "same-function-changed" });
  });
});

describe("path map", () => {
  it("with several prefixes, the longest matching one wins", () => {
    const pathMap: PathMap = { "/app": "", "/app/src": "src", "/app/src/vendor": "third-party" };
    expect(applyPathMap("/app/src/orders/service.ts", pathMap)).toBe("src/orders/service.ts");
    expect(applyPathMap("/app/src/vendor/left-pad.js", pathMap)).toBe("third-party/left-pad.js");
    expect(applyPathMap("/app/package.json", pathMap)).toBe("package.json");
  });

  it("matches whole folder names only, and leaves unmatched paths alone", () => {
    const pathMap: PathMap = { "/app": "", "/srv/api/": "api/" };
    expect(applyPathMap("/application/main.ts", pathMap)).toBe("/application/main.ts");
    expect(applyPathMap("/srv/api/handler.ts", pathMap)).toBe("api/handler.ts");
    expect(applyPathMap("node:internal/process/task_queues", pathMap)).toBe("node:internal/process/task_queues");
    expect(applyPathMap("./src/a.ts", undefined)).toBe("src/a.ts");
  });
});

// ---------------------------------------------------------------------------
// Python code-reading rules
// ---------------------------------------------------------------------------

const PYTHON_SERVICE = [
  '"""Orders."""', //                                   1
  "import logging", //                                   2
  "from shop.users.repo import get_user", //             3
  "from . import pricing", //                            4
  "import shop.mail.sender as mail", //                  5
  "", //                                                 6
  "", //                                                 7
  "class OrderService:", //                              8
  "    @staticmethod", //                                9
  "    def create_order(", //                            10
  "        order: dict,", //                             11
  "        user_id: str = '',", //                       12
  "    ) -> dict:", //                                   13
  '        user = get_user(order["user_id"])  # one step', // 14
  "        total, tax = pricing.compute(order)", //      15
  "        email = user.email", //                       16
  "        self.notify(email, total + tax)", //          17
  '        return {"email": email}', //                  18
  "", //                                                 19
  "    async def notify(self, email: str, amount: float) -> None:", // 20
  "        await mail.send(email, amount)", //           21
  "", //                                                 22
  "", //                                                 23
  "def get_user(user_id): return None", //              24
  "",
].join("\n");

describe("Python code rules", () => {
  it("function names: plain names stay, <module> and <lambda> give none", () => {
    expect(readPythonFunctionName("create_order")).toBe("create_order");
    expect(readPythonFunctionName("OrderService.create_order")).toBe("create_order");
    expect(readPythonFunctionName("<module>")).toBeUndefined();
    expect(readPythonFunctionName("<lambda>")).toBeUndefined();
  });

  it("finds def, async def and methods inside a class", () => {
    expect(findPythonFunctionDefinitionLine(PYTHON_SERVICE, "create_order")).toEqual({ lineNumber: 10, lineText: "    def create_order(" });
    expect(findPythonFunctionDefinitionLine(PYTHON_SERVICE, "notify")?.lineNumber).toBe(20);
    expect(findPythonFunctionDefinitionLine(PYTHON_SERVICE, "get_user")?.lineNumber).toBe(24);
  });

  it("measures a function from its indentation: decorators, a long signature, a one-line def", () => {
    expect(findPythonFunctionLineRange(PYTHON_SERVICE, "create_order", 16)).toEqual({ startLine: 9, endLine: 18 });
    expect(findPythonFunctionLineRange(PYTHON_SERVICE, "notify")).toEqual({ startLine: 20, endLine: 21 });
    expect(findPythonFunctionLineRange(PYTHON_SERVICE, "get_user")).toEqual({ startLine: 24, endLine: 24 });
    // A line outside every function named so gives nothing (the caller then
    // uses the ±3-line fallback).
    expect(findPythonFunctionLineRange(PYTHON_SERVICE, "notify", 16)).toBeUndefined();
  });

  it("crash-line inputs: assignments above the crash in the same function, and the functions they call", () => {
    expect(findPythonCrashLineInputs(PYTHON_SERVICE, 16, "create_order")).toEqual({ inputLineNumbers: [14], calleeNames: ["get_user"] });
    expect(findPythonCrashLineInputs(PYTHON_SERVICE, 17, "create_order")).toEqual({
      inputLineNumbers: [15, 16],
      calleeNames: ["pricing.compute", "self.notify"],
    });
  });

  it("module files: absolute modules under every parent folder, relative ones from the file's folder", () => {
    expect(findModuleFilePaths("src/shop/orders/service.py", "shop.users.repo")).toEqual([
      "src/shop/orders/shop/users/repo.py",
      "src/shop/orders/shop/users/repo/__init__.py",
      "src/shop/shop/users/repo.py",
      "src/shop/shop/users/repo/__init__.py",
      "src/shop/users/repo.py",
      "src/shop/users/repo/__init__.py",
      "shop/users/repo.py",
      "shop/users/repo/__init__.py",
    ]);
    expect(findModuleFilePaths("src/shop/orders/service.py", ".pricing")).toEqual(["src/shop/orders/pricing.py", "src/shop/orders/pricing/__init__.py"]);
    expect(findModuleFilePaths("src/shop/orders/service.py", "..users.repo")).toEqual(["src/shop/users/repo.py", "src/shop/users/repo/__init__.py"]);
    expect(findModuleFilePaths("src/shop/orders/service.py", ".")).toEqual(["src/shop/orders/__init__.py"]);
    expect(findModuleFilePaths("app.py", "..outside")).toEqual([]);
  });

  it("callees: from-imports, imported modules, self methods and same-file functions", () => {
    const filePath = "src/shop/orders/service.py";
    expect(findPythonCalleeLocation(PYTHON_SERVICE, filePath, "get_user")).toEqual({
      definitionName: "get_user",
      candidatePaths: findModuleFilePaths(filePath, "shop.users.repo"),
    });
    expect(findPythonCalleeLocation(PYTHON_SERVICE, filePath, "pricing.compute")).toEqual({
      definitionName: "compute",
      candidatePaths: ["src/shop/orders/pricing.py", "src/shop/orders/pricing/__init__.py"],
    });
    expect(findPythonCalleeLocation(PYTHON_SERVICE, filePath, "mail.send")).toEqual({
      definitionName: "send",
      candidatePaths: findModuleFilePaths(filePath, "shop.mail.sender"),
    });
    expect(findPythonCalleeLocation(PYTHON_SERVICE, filePath, "self.notify")).toEqual({ definitionName: "notify", candidatePaths: [filePath] });
    expect(findPythonCalleeLocation(PYTHON_SERVICE, filePath, "logging")).toBeUndefined();
    expect(findPythonCalleeLocation(PYTHON_SERVICE, filePath, "unknown_function")).toBeUndefined();
  });

  it("library frames: site-packages, dist-packages, the standard library and <frozen ...>", () => {
    expect(isPythonLibraryFrame("/usr/local/lib/python3.12/site-packages/fastapi/routing.py")).toBe(true);
    expect(isPythonLibraryFrame("/usr/lib/python3/dist-packages/requests/api.py")).toBe(true);
    expect(isPythonLibraryFrame("/usr/local/lib/python3.12/asyncio/tasks.py")).toBe(true);
    expect(isPythonLibraryFrame("<frozen runpy>")).toBe(true);
    expect(isPythonLibraryFrame("/app/src/shop/orders/service.py")).toBe(false);
    expect(isPythonLibraryFrame("/app/src/shop/library/python_helpers.py")).toBe(false);
  });
});

describe("Python suspect attribution on small temp repos", () => {
  const repos: SmallRepo[] = [];
  afterAll(() => {
    for (const repo of repos) rmSync(repo.root, { recursive: true, force: true });
  });

  // A method inside a class. git's own `-L :create_order:` finds no method
  // inside a class; vika measures the method itself, so a change far above
  // the crash line (outside the ±3-line fallback) still counts.
  const serviceSource = (discountLine: string) =>
    [
      "from shop.users.repo import get_user",
      "",
      "",
      "class OrderService:",
      "    def create_order(self, order):",
      discountLine,
      "        items = order['items']",
      "        count = len(items)",
      "        first = items[0]",
      "        last = items[-1]",
      "        name = first['name']",
      "        return name.upper()",
      "",
    ].join("\n");

  it("finds a change anywhere in the crashing method, not only near the crash line", async () => {
    const repo = buildSmallRepo();
    repos.push(repo);
    const previousSha = repo.commit({ "src/shop/orders/service.py": serviceSource("        discount = 0") }, { message: "Add orders (#1)", author: ALICE, time: "2026-04-01T09:00:00Z" });
    const changeSha = repo.commit({ "src/shop/orders/service.py": serviceSource("        discount = order['discount']") }, { message: "Read the discount (#2)", author: BOB, time: "2026-04-02T09:00:00Z" });
    const frame: Frame = { file: "/app/src/shop/orders/service.py", line: 12, fn: "create_order" };
    const commitsInRange = await listCommitsInRange(repo.repoPath, previousSha, changeSha);
    const pythonResult = await attributeRegression({
      repoPath: repo.repoPath, deploySha: changeSha, previousSha, topFrames: [frame], pathMap: { "/app/src": "src" }, language: "python", commitsInRange,
    });
    expect(pythonResult.suspects[0]).toMatchObject({ commitSha: changeSha, evidenceKind: "same-function-changed", filePath: "src/shop/orders/service.py" });
  });

  it("falls back to the lines around the crash when the frame has no function name", async () => {
    const repo = buildSmallRepo();
    repos.push(repo);
    const settings = (port: string) => ["import os", "", `PORT = int(os.environ.get('PORT', '${port}'))`, "HOST = os.environ['HOST']", ""].join("\n");
    const previousSha = repo.commit({ "src/settings.py": settings("8000") }, { message: "Settings (#1)", author: ALICE, time: "2026-04-01T09:00:00Z" });
    const changeSha = repo.commit({ "src/settings.py": settings("80") }, { message: "Default port 80 (#2)", author: BOB, time: "2026-04-02T09:00:00Z" });
    const result = await attributeRegression({
      repoPath: repo.repoPath,
      deploySha: changeSha,
      previousSha,
      topFrames: [{ file: "src/settings.py", line: 4, fn: "<module>" }],
      language: "python",
      commitsInRange: await listCommitsInRange(repo.repoPath, previousSha, changeSha),
    });
    expect(result.suspects[0]).toMatchObject({ commitSha: changeSha, evidenceKind: "same-function-changed" });
  });
});
