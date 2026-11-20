// Tests the fixture itself: if these fail, every later test built on it is meaningless.
import { readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKGROUND_ERROR, buildFixture, git, type Fixture } from "./fixture/build.js";

// A log entry: a timestamped line plus any continuation lines (stack trace).
interface Entry {
  time: number;
  text: string;
}

// Splits app.log into entries. A new entry starts with an ISO timestamp.
function readEntries(logPath: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (line === "") continue;
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) /.exec(line);
    if (match?.[1]) entries.push({ time: Date.parse(match[1]), text: line });
    else if (entries.length > 0) entries[entries.length - 1]!.text += "\n" + line;
    else throw new Error(`log starts with a continuation line: ${line}`);
  }
  return entries;
}

const isNewError = (e: Entry) => e.text.includes("TypeError:");
const isBackground = (e: Entry) => e.text.includes(BACKGROUND_ERROR);

// Reads the top app frame (file, line) from the first new-error stack trace.
function topFrame(entries: Entry[]): { file: string; line: number } {
  const first = entries.find(isNewError);
  const match = first && /at \S+ \(\/app\/(src\/[^:]+):(\d+):\d+\)/.exec(first.text);
  if (!match?.[1] || !match[2]) throw new Error("no app stack frame found");
  return { file: match[1], line: Number(match[2]) };
}

// Returns the sha git blame gives for one line of a file at a given commit.
function blame(repoDir: string, sha: string, file: string, line: number): string {
  const out = git(repoDir, ["blame", "--porcelain", "-L", `${line},${line}`, sha, "--", file]);
  return out.split(" ")[0]!;
}

const fixtures: Fixture[] = [];
afterAll(() => {
  for (const f of fixtures) rmSync(f.root, { recursive: true, force: true });
});

describe.each(["direct", "indirect"] as const)("fixture: %s", (scenario) => {
  let fx: Fixture;
  let entries: Entry[];

  beforeAll(() => {
    fx = buildFixture(scenario);
    fixtures.push(fx);
    entries = readEntries(fx.logPath);
  }, 30_000);

  const badDeploy = () => fx.deploys.find((d) => d.sha === fx.expected.badDeploySha)!;

  it("writes a repo with ~10 commits, several authors and PR numbers", () => {
    const log = git(fx.repoDir, ["log", "--format=%an|%s"]).split("\n");
    expect(log.length).toBeGreaterThanOrEqual(9);
    expect(new Set(log.map((l) => l.split("|")[0])).size).toBeGreaterThanOrEqual(2);
    for (const l of log) expect(l).toMatch(/ \(#\d+\)$/);
  });

  it("has a deploy timeline where each deploy points at the previous one", () => {
    expect(fx.deploys.length).toBeGreaterThanOrEqual(4);
    expect(fx.deploys[0]!.previousSha).toBeNull();
    for (let i = 1; i < fx.deploys.length; i++) {
      expect(fx.deploys[i]!.previousSha).toBe(fx.deploys[i - 1]!.sha);
    }
  });

  it("expected.json matches the returned answer", () => {
    expect(JSON.parse(readFileSync(fx.expectedPath, "utf8"))).toEqual(fx.expected);
    expect(fx.expected.productionBranch).toBe("main");
    expect(fx.expected.previousSha).toBe(badDeploy().previousSha);
    expect(fx.expected.suspectPr).toBe(812);
    expect(fx.expected.suspectAuthor).toBe("Tomas Ortega");
  });

  it("never logs the new error before the bad deploy", () => {
    const deployTime = Date.parse(badDeploy().time);
    const newErrors = entries.filter(isNewError);
    expect(newErrors.length).toBeGreaterThan(5);
    for (const e of newErrors) expect(e.time).toBeGreaterThan(deployTime);
    // First seen about 4 minutes after the deploy, and recorded correctly.
    expect(newErrors[0]!.time).toBe(Date.parse(fx.expected.errorFirstSeen));
    expect(newErrors[0]!.time - deployTime).toBeGreaterThanOrEqual(3 * 60_000);
    expect(newErrors[0]!.time - deployTime).toBeLessThanOrEqual(5 * 60_000);
  });

  it("logs the background error both before and after every deploy", () => {
    const times = entries.filter(isBackground).map((e) => e.time);
    for (const d of fx.deploys) {
      const t = Date.parse(d.time);
      expect(times.some((x) => x < t)).toBe(true);
      expect(times.some((x) => x > t)).toBe(true);
    }
    // ...and on every day of the log, not just around deploys.
    const days = new Set(times.map((x) => new Date(x).toISOString().slice(0, 10)));
    const allDays = new Set(entries.map((e) => new Date(e.time).toISOString().slice(0, 10)));
    expect(allDays.size).toBeGreaterThanOrEqual(10);
    expect(days).toEqual(allDays);
  });

  it("has realistic noise and a multi-line stack trace", () => {
    const text = readFileSync(fx.logPath, "utf8");
    expect(text).toMatch(/user=u_\d{5}/);
    expect(text).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);
    expect(text).toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(text).toMatch(/[a-z]+\.\d+@example\.(com|org|net)/);
    expect(entries.find(isNewError)!.text.split("\n").length).toBeGreaterThan(3);
  });

  it("puts the expected commit inside the bad deploy's range", () => {
    const d = badDeploy();
    const range = git(fx.repoDir, ["rev-list", `${d.previousSha}..${d.sha}`]).split("\n");
    expect(range.length).toBeGreaterThan(1); // more than one candidate to choose from
    expect(range).toContain(fx.expected.suspectSha);
  });

  if (scenario === "direct") {
    it("blames the top stack frame on the expected commit", () => {
      const { file, line } = topFrame(entries);
      expect(blame(fx.repoDir, fx.expected.badDeploySha, file, line)).toBe(fx.expected.suspectSha);
    });
  } else {
    it("blames the top stack frame on an older commit, not the expected one", () => {
      const { file, line } = topFrame(entries);
      const blamed = blame(fx.repoDir, fx.expected.badDeploySha, file, line);
      expect(blamed).not.toBe(fx.expected.suspectSha);
      // The blamed commit is from before the bad deploy's range.
      const d = badDeploy();
      const range = git(fx.repoDir, ["rev-list", `${d.previousSha}..${d.sha}`]).split("\n");
      expect(range).not.toContain(blamed);
    });
  }

  it("is deterministic: a second build gives identical files and SHAs", () => {
    const again = buildFixture(scenario);
    fixtures.push(again);
    expect(again.expected).toEqual(fx.expected);
    expect(again.deploys).toEqual(fx.deploys);
    expect(git(again.repoDir, ["rev-list", "HEAD"])).toBe(git(fx.repoDir, ["rev-list", "HEAD"]));
    expect(readFileSync(again.logPath, "utf8")).toBe(readFileSync(fx.logPath, "utf8"));
  }, 30_000);
});

describe("fixture: branchName option", () => {
  it('builds on a "production" branch and records it in expected.json', () => {
    const fx = buildFixture("direct", { branchName: "production" });
    fixtures.push(fx);
    expect(git(fx.repoDir, ["branch", "--show-current"])).toBe("production");
    expect(fx.expected.productionBranch).toBe("production");
    expect(JSON.parse(readFileSync(fx.expectedPath, "utf8")).productionBranch).toBe("production");
    // The deployed shas are on the production branch.
    const onBranch = git(fx.repoDir, ["rev-list", "production"]).split("\n");
    for (const d of fx.deploys) expect(onBranch).toContain(d.sha);
  }, 30_000);
});
