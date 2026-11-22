// Tests the deploy timeline: pure functions, the read-only git readers on the
// fixture repo, and saving through the store (Postgres via TEST_DATABASE_URL).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/database/database-store.js";
import type { Deploy } from "../src/database/store-types.js";
import { checkShaOnBranch } from "../src/deploys/check-sha-on-branch.js";
import { listCommitsInRange } from "../src/deploys/commits-in-range.js";
import { buildMarkerDeploy } from "../src/deploys/marker-deploys.js";
import { mergesToDeploys, parseMergeLog, type MergeCommit } from "../src/deploys/merge-log.js";
import { extractPrNumber } from "../src/deploys/pull-request-number.js";
import { readMergeDeploys } from "../src/deploys/read-merge-deploys.js";
import { recordDeploys } from "../src/deploys/record-deploys.js";
import { isStartingPoint } from "../src/deploys/starting-point.js";
import { buildFixture, git, type Fixture } from "./fixture/build.js";

const sha = (c: string) => c.repeat(40);

const fixtures: Fixture[] = [];
function fixture(scenario: "direct" | "indirect" = "direct", branchName?: string): Fixture {
  const fx = buildFixture(scenario, branchName === undefined ? {} : { branchName });
  fixtures.push(fx);
  return fx;
}
afterAll(() => {
  for (const fx of fixtures) rmSync(fx.root, { recursive: true, force: true });
});

// Makes one extra commit in a fixture repo (only ever a temp repo).
function commitFile(repoDir: string, path: string, content: string, message: string, time: string): string {
  mkdirSync(join(repoDir, path, ".."), { recursive: true });
  writeFileSync(join(repoDir, path), content);
  git(repoDir, ["add", "-A"]);
  const who = { name: "Mei Chen", email: "mei@example.com" };
  const date = `${Math.floor(Date.parse(time) / 1000)} +0000`;
  git(repoDir, ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", message], {
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: who.name,
    GIT_COMMITTER_EMAIL: who.email,
    GIT_COMMITTER_DATE: date,
  });
  return git(repoDir, ["rev-parse", "HEAD"]);
}

describe("parseMergeLog", () => {
  it("reads normal output, oldest first, in UTC", () => {
    const out = [
      `${sha("c")}|${sha("b")}|2026-03-06T13:05:00+02:00|Add health check | with a pipe (#813)`,
      `${sha("b")}|${sha("a")} ${sha("9")}|2026-03-06T11:20:00Z|Merge pull request #812 from team/discounts`,
      `${sha("a")}||2026-03-01T09:12:00Z|Initial project setup (#801)`,
    ].join("\n");
    const { commits, skipped } = parseMergeLog(out + "\n");
    expect(skipped).toBe(0);
    expect(commits).toEqual([
      { sha: sha("a"), parents: [], time: "2026-03-01T09:12:00.000Z", subject: "Initial project setup (#801)" },
      { sha: sha("b"), parents: [sha("a"), sha("9")], time: "2026-03-06T11:20:00.000Z", subject: "Merge pull request #812 from team/discounts" },
      { sha: sha("c"), parents: [sha("b")], time: "2026-03-06T11:05:00.000Z", subject: "Add health check | with a pipe (#813)" },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parseMergeLog("")).toEqual({ commits: [], skipped: 0 });
    expect(parseMergeLog("\n\n")).toEqual({ commits: [], skipped: 0 });
  });

  it("skips and counts a garbage line", () => {
    const out = `${sha("a")}||2026-03-01T09:12:00Z|Initial (#801)\nfatal: something odd happened\n`;
    const { commits, skipped } = parseMergeLog(out);
    expect(commits).toHaveLength(1);
    expect(skipped).toBe(1);
  });
});

describe("mergesToDeploys", () => {
  const commits: MergeCommit[] = [
    { sha: sha("a"), parents: [], time: "2026-03-01T09:12:00.000Z", subject: "one" },
    { sha: sha("b"), parents: [sha("a")], time: "2026-03-02T09:12:00.000Z", subject: "two" },
    { sha: sha("c"), parents: [sha("b")], time: "2026-03-03T09:12:00.000Z", subject: "three" },
  ];

  it("keeps order, chains previousSha, and starts with null", () => {
    const deploys = mergesToDeploys("api", commits);
    expect(deploys.map((d) => d.sha)).toEqual([sha("a"), sha("b"), sha("c")]);
    expect(deploys.map((d) => d.previousSha)).toEqual([null, sha("a"), sha("b")]);
    expect(deploys.every((d) => d.service === "api" && d.source === "merges")).toBe(true);
    expect(isStartingPoint(deploys[0]!)).toBe(true);
    expect(isStartingPoint(deploys[1]!)).toBe(false);
  });

  it("gives no deploys for no commits", () => {
    expect(mergesToDeploys("api", [])).toEqual([]);
  });
});

describe("buildMarkerDeploy", () => {
  const base = { service: "api", sha: sha("c"), time: "2026-03-06T16:00:00+02:00" };

  it("uses an explicit previousSha first", () => {
    expect(buildMarkerDeploy({ ...base, previousSha: sha("a"), lastKnownSha: sha("b") })).toEqual({
      service: "api",
      sha: sha("c"),
      previousSha: sha("a"),
      time: "2026-03-06T14:00:00.000Z",
      source: "marker",
    });
  });

  it("falls back to the last known deploy", () => {
    expect(buildMarkerDeploy({ ...base, lastKnownSha: sha("b") }).previousSha).toBe(sha("b"));
  });

  it("gives null (a starting point) when there is neither", () => {
    const deploy = buildMarkerDeploy(base);
    expect(deploy.previousSha).toBeNull();
    expect(isStartingPoint(deploy)).toBe(true);
  });

  it("rejects a time that isn't a time", () => {
    expect(() => buildMarkerDeploy({ ...base, time: "yesterday-ish" })).toThrow(/invalid deploy time/);
  });
});

describe("extractPrNumber", () => {
  it("reads squash style", () => expect(extractPrNumber("Apply order discounts to total (#812)")).toBe(812));
  it("reads merge-commit style", () => expect(extractPrNumber("Merge pull request #812 from team/discounts")).toBe(812));
  it("gives null when there is no number", () => {
    expect(extractPrNumber("Bump version")).toBeNull();
    expect(extractPrNumber("Fix #812 later")).toBeNull();
  });
});

describe("fixture: marker source", () => {
  it("chains deploys.json via lastKnownSha; the bad deploy's previousSha matches expected.json", () => {
    const fx = fixture();
    const raw = JSON.parse(readFileSync(fx.deploysPath, "utf8")) as { sha: string; time: string }[];

    const deploys: Deploy[] = [];
    for (const d of raw) {
      deploys.push(buildMarkerDeploy({ service: "shopfront", sha: d.sha, time: d.time, lastKnownSha: deploys.at(-1)?.sha ?? null }));
    }
    expect(deploys[0]!.previousSha).toBeNull();
    const bad = deploys.find((d) => d.sha === fx.expected.badDeploySha)!;
    expect(bad.previousSha).toBe(fx.expected.previousSha);
    expect(bad.time).toBe(fx.deploys.find((d) => d.sha === bad.sha)!.time);
  });
});

describe("fixture: merges source", () => {
  it("gives one deploy per commit on the production branch", async () => {
    const fx = fixture();
    const deploys = await readMergeDeploys(fx.repoDir, "main", "shopfront");
    const onBranch = git(fx.repoDir, ["rev-list", "--first-parent", "--reverse", "main"]).split("\n");
    expect(deploys.map((d) => d.sha)).toEqual(onBranch);
    expect(deploys).toHaveLength(10);
    expect(deploys[0]!.previousSha).toBeNull();
    for (let i = 1; i < deploys.length; i++) expect(deploys[i]!.previousSha).toBe(deploys[i - 1]!.sha);
    expect(deploys[0]!.time).toBe("2026-03-01T09:12:00.000Z");
  });

  it("the bad deploy's range contains the suspect commit and its PR number", async () => {
    const fx = fixture("indirect");
    const range = await listCommitsInRange(fx.repoDir, fx.expected.previousSha, fx.expected.badDeploySha);
    expect(range.length).toBeGreaterThan(1);
    const suspect = range.find((c) => c.sha === fx.expected.suspectSha);
    expect(suspect).toMatchObject({
      prNumber: fx.expected.suspectPr,
      authorName: fx.expected.suspectAuthor,
      authorEmail: fx.expected.suspectEmail,
      time: "2026-03-06T11:20:00.000Z",
    });
    expect(range.at(-1)!.sha).toBe(fx.expected.badDeploySha); // oldest first, deploy sha last

    // In the merges timeline, the deploy that first ships the suspect is the
    // suspect commit itself, and its range is exactly that one commit.
    const deploys = await readMergeDeploys(fx.repoDir, "main", "shopfront");
    const first = deploys.find((d) => d.sha === fx.expected.suspectSha)!;
    const own = await listCommitsInRange(fx.repoDir, first.previousSha, first.sha);
    expect(own.map((c) => [c.sha, c.prNumber])).toEqual([[fx.expected.suspectSha, fx.expected.suspectPr]]);
  });

  it("gives an empty range for a starting point", async () => {
    const fx = fixture();
    expect(await listCommitsInRange(fx.repoDir, null, fx.expected.badDeploySha)).toEqual([]);
  });
});

describe('fixture: branch "production"', () => {
  it('reads "production", and reading "main" fails with a clear message', async () => {
    const fx = fixture("direct", "production");
    expect(await readMergeDeploys(fx.repoDir, "production", "shopfront")).toHaveLength(10);
    await expect(readMergeDeploys(fx.repoDir, "main", "shopfront")).rejects.toThrow(/branch "main" does not exist/);
  });
});

describe("checkShaOnBranch", () => {
  it("is true for a commit on the branch and false (with a reason) otherwise", async () => {
    const fx = fixture();
    expect(await checkShaOnBranch(fx.repoDir, fx.expected.suspectSha, "main")).toEqual({ onBranch: true });

    // A commit that exists, but only on a side branch.
    git(fx.repoDir, ["branch", "-q", "side"]);
    git(fx.repoDir, ["checkout", "-q", "side"]);
    const sideSha = commitFile(fx.repoDir, "src/side.ts", "export {};\n", "Side work (#900)", "2026-03-10T10:00:00Z");
    git(fx.repoDir, ["checkout", "-q", "main"]);
    expect(await checkShaOnBranch(fx.repoDir, sideSha, "main")).toEqual({
      onBranch: false,
      reason: `commit ${sideSha} is not on branch "main"`,
    });

    expect((await checkShaOnBranch(fx.repoDir, sha("d"), "main")).reason).toMatch(/does not exist/);
    expect((await checkShaOnBranch(fx.repoDir, fx.expected.suspectSha, "nope")).reason).toBe(`branch "nope" does not exist in ${fx.repoDir}`);
  });

  it("refuses values that git would read as options", async () => {
    const fx = fixture();
    await expect(checkShaOnBranch(fx.repoDir, "--output=/tmp/x", "main")).rejects.toThrow(/invalid sha/);
    await expect(readMergeDeploys(fx.repoDir, "--all", "shopfront")).rejects.toThrow(/invalid branch/);
  });
});

describe("monorepo prefix", () => {
  it("a commit that only changes files outside the prefix is not a deploy for that service", async () => {
    const fx = fixture();
    const docsOnly = commitFile(fx.repoDir, "docs/runbook.md", "# Runbook\n", "Write runbook (#901)", "2026-03-10T09:00:00Z");
    const ordersChange = commitFile(fx.repoDir, "src/orders/limits.ts", "export const MAX = 5;\n", "Add order limits (#902)", "2026-03-10T10:00:00Z");

    const all = await readMergeDeploys(fx.repoDir, "main", "shopfront");
    const src = await readMergeDeploys(fx.repoDir, "main", "shopfront", "src/");
    const orders = await readMergeDeploys(fx.repoDir, "main", "orders", "src/orders");

    expect(all.map((d) => d.sha)).toContain(docsOnly);
    expect(src.map((d) => d.sha)).not.toContain(docsOnly);
    expect(src.map((d) => d.sha)).toContain(ordersChange);
    expect(src.length).toBeLessThan(all.length); // README-only and package.json-only commits also drop out

    // The orders service: only commits under src/orders/, chained to each other.
    const subjects = git(fx.repoDir, ["log", "--format=%s", "--", "src/orders"]).split("\n").reverse();
    expect(orders).toHaveLength(subjects.length);
    expect(orders.at(-1)!.sha).toBe(ordersChange);
    expect(orders[0]!.previousSha).toBeNull();
    for (let i = 1; i < orders.length; i++) expect(orders[i]!.previousSha).toBe(orders[i - 1]!.sha);
  });
});

describe("read-only", () => {
  it("leaves HEAD, refs and the working tree unchanged after all readers run", async () => {
    const fx = fixture();
    writeFileSync(join(fx.repoDir, "uncommitted.txt"), "work in progress\n"); // a dirty working copy
    const snapshot = () => ({
      head: git(fx.repoDir, ["rev-parse", "HEAD"]),
      branch: git(fx.repoDir, ["symbolic-ref", "HEAD"]),
      refs: git(fx.repoDir, ["for-each-ref"]),
      status: git(fx.repoDir, ["status", "--porcelain", "--untracked-files=all"]),
      index: readFileSync(join(fx.repoDir, ".git", "index")).toString("base64"),
    });
    const before = snapshot();

    const deploys = await readMergeDeploys(fx.repoDir, "main", "shopfront");
    await readMergeDeploys(fx.repoDir, "main", "shopfront", "src/");
    for (const d of deploys) await listCommitsInRange(fx.repoDir, d.previousSha, d.sha);
    await checkShaOnBranch(fx.repoDir, fx.expected.suspectSha, "main");
    await checkShaOnBranch(fx.repoDir, fx.expected.suspectSha, "missing");

    expect(snapshot()).toEqual(before);
  });
});

describe("recordDeploys (Postgres)", () => {
  let store: Store;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set. Copy .env.example to .env.");
    store = await openStore(url, { schema: `vika_test_${randomBytes(6).toString("hex")}` });
  });
  afterAll(async () => {
    await store?.close();
  });

  it("saving twice gives one row per deploy", async () => {
    const fx = fixture();
    const deploys = await readMergeDeploys(fx.repoDir, "main", "shopfront");

    expect(await recordDeploys(store, deploys)).toEqual({ added: 10, alreadyKnown: 0 });
    expect(await recordDeploys(store, deploys)).toEqual({ added: 0, alreadyKnown: 10 });

    const saved = await store.listDeploys("shopfront");
    expect(saved).toEqual(deploys);
    expect(saved[0]!.previousSha).toBeNull(); // the starting point
  });
});
