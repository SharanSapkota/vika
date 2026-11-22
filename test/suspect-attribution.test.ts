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
import { NO_STRONG_SUSPECT_MESSAGE } from "../src/suspect-attribution/score-suspects.js";
import type { AttributionResult, PathMap } from "../src/suspect-attribution/suspect-types.js";
import { buildFixture, git, type Fixture, type Scenario } from "./fixture/build.js";
import { buildSmallRepo, type Person, type SmallRepo } from "./fixture/build-small-repo.js";

// The fixture's stack traces say /app/src/...; the repo has src/...
const APP_PATH_MAP: PathMap = { "/app/src": "src" };

const ALICE: Person = { name: "Alice Novak", email: "alice@example.com" };
const BOB: Person = { name: "Bob Lindqvist", email: "bob@example.com" };
const DEPENDABOT: Person = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };

// The new error's top frames, the way the real pipeline produces them.
function readNewErrorFrames(fixture: Fixture): Frame[] {
  const { entries } = parseLines(readFileSync(fixture.logPath, "utf8").split("\n"));
  const newErrorCluster = buildClusters(entries, "shopfront").clusters.find((cluster) => cluster.template.includes("TypeError"));
  if (!newErrorCluster) throw new Error("fixture has no TypeError cluster");
  return newErrorCluster.topFrames;
}

async function attributeFixture(fixture: Fixture, pathMap: PathMap | null = APP_PATH_MAP): Promise<AttributionResult> {
  // null = no path map (undefined would pick the default above).
  const { badDeploySha, previousSha } = fixture.expected;
  return attributeRegression({
    repoPath: fixture.repoDir,
    deploySha: badDeploySha,
    previousSha,
    topFrames: readNewErrorFrames(fixture),
    ...(pathMap ? { pathMap } : {}),
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
    fixtures.direct = buildFixture("direct");
    fixtures.indirect = buildFixture("indirect");
  }, 60_000);

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
      await blameLine(fixture.repoDir, fixture.expected.badDeploySha, "src/orders/service.ts", 1, []);
      expect(snapshotRepoState(fixture.repoDir)).toBe(before);
    }
  });

  it("names the right top suspect for every seeded bug", async () => {
    const scenarios: Scenario[] = ["direct", "indirect"];
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
