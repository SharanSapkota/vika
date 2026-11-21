// Tests the Postgres store. Uses TEST_DATABASE_URL only (never DATABASE_URL),
// and a fresh Postgres schema per test file so runs don't affect each other.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildClusters, emptyState, type Cluster } from "../src/cluster.js";
import { parseLines } from "../src/parse/index.js";
import { readFile } from "../src/parse/source.js";
import { openStore, type Batch, type Bookmark, type Store } from "../src/store.js";
import { BACKGROUND_ERROR, buildFixture, type Fixture } from "./fixture/build.js";

function testUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set. Copy .env.example to .env.");
  return url;
}

// A new, unique schema name (lower-case letters, digits, underscores).
const freshSchema = () => `vika_test_${randomBytes(6).toString("hex")}`;

const BOOKMARK: Bookmark = { sourceKey: "/var/log/app.log", file: { offset: 120, inode: 4242 } };

// A small cluster for hand-made batches.
function cluster(service: string, fingerprint: string, extra: Partial<Cluster> = {}): Cluster {
  return {
    fingerprint,
    service,
    template: "DB timeout after <num>ms",
    countsPerMinute: { "2026-03-06T14:00:00.000Z": 2, "2026-03-06T14:01:00.000Z": 3 },
    firstSeen: "2026-03-06T14:00:10.000Z",
    lastSeen: "2026-03-06T14:01:50.000Z",
    examples: ["DB timeout after 5000ms"],
    sourceRefs: [],
    topFrames: [],
    ...extra,
  };
}

function batch(service: string, clusters: Cluster[], bookmark: Bookmark = BOOKMARK): Batch {
  return { service, clusters, minerState: emptyState(), bookmark };
}

const ALL_TIME = ["2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"] as const;

let store: Store;
const schema = freshSchema();

beforeAll(async () => {
  store = await openStore(testUrl(), { schema });
});
afterAll(async () => {
  await store?.close();
});

describe("migrations", () => {
  it("apply once; opening the store again doesn't fail or repeat them", async () => {
    expect(await store.appliedMigrations()).toEqual(["001_init"]);
    const second = await openStore(testUrl(), { schema });
    try {
      expect(await second.appliedMigrations()).toEqual(["001_init"]);
    } finally {
      await second.close();
    }
  });

  it("two processes migrating a new schema at the same time both succeed", async () => {
    const other = freshSchema();
    const [a, b] = await Promise.all([openStore(testUrl(), { schema: other }), openStore(testUrl(), { schema: other })]);
    try {
      expect(await a.appliedMigrations()).toEqual(["001_init"]);
      expect(await b.appliedMigrations()).toEqual(["001_init"]);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});

describe("saveBatch", () => {
  it("adds counts each time the same batch is saved, and saves the bookmark", async () => {
    const svc = "same-batch";
    await store.saveBatch(batch(svc, [cluster(svc, "fp1")]));
    await store.saveBatch(batch(svc, [cluster(svc, "fp1")]));
    // By design, counts are added: the bookmark (not the store) is what stops
    // the same lines from being read twice.
    expect(await store.getClusterCounts(svc, "fp1", ...ALL_TIME)).toEqual({
      "2026-03-06T14:00:00.000Z": 4,
      "2026-03-06T14:01:00.000Z": 6,
    });
    expect(await store.getBookmark(svc, BOOKMARK.sourceKey)).toEqual(BOOKMARK);
    expect(await store.getMinerState(svc)).toEqual(emptyState());
  });

  it("with the bookmark logic, re-running on an unchanged file counts nothing twice", async () => {
    const svc = "bookmark-logic";
    const dir = mkdtempSync(join(tmpdir(), "vika-store-"));
    const path = join(dir, "app.log");
    writeFileSync(path, "2026-03-06T14:00:01Z ERROR DB timeout after 5000ms\n2026-03-06T14:00:02Z ERROR DB timeout after 3000ms\n");

    // One run of the pipeline: bookmark -> read new lines -> parse -> cluster -> save.
    const runOnce = async () => {
      const bookmark = await store.getBookmark(svc, path);
      const read = await readFile(path, bookmark?.file);
      const { clusters, state } = buildClusters(parseLines(read.lines).entries, svc, await store.getMinerState(svc));
      await store.saveBatch({ service: svc, clusters, minerState: state, bookmark: { sourceKey: path, file: read.next } });
      return clusters;
    };
    try {
      const [group] = await runOnce();
      await runOnce(); // nothing new in the file
      expect(await store.getClusterCounts(svc, group!.fingerprint, ...ALL_TIME)).toEqual({ "2026-03-06T14:00:00.000Z": 2 });

      appendFileSync(path, "2026-03-06T14:00:30Z ERROR DB timeout after 4000ms\n");
      await runOnce();
      expect(await store.getClusterCounts(svc, group!.fingerprint, ...ALL_TIME)).toEqual({ "2026-03-06T14:00:00.000Z": 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves nothing behind when a batch fails midway (rollback)", async () => {
    const svc = "rollback";
    const good = cluster(svc, "good");
    const broken = cluster(svc, "broken", { firstSeen: "not a timestamp" }); // Postgres rejects this
    await expect(store.saveBatch(batch(svc, [good, broken]))).rejects.toThrow();

    expect(await store.getCluster(svc, "good")).toBeUndefined();
    expect(await store.getClusterCounts(svc, "good", ...ALL_TIME)).toEqual({});
    expect(await store.getMinerState(svc)).toBeUndefined();
    expect(await store.getBookmark(svc, BOOKMARK.sourceKey)).toBeUndefined();
  });

  it("adds counts for the same minute from two batches", async () => {
    const svc = "same-minute";
    const minute = "2026-03-06T15:00:00.000Z";
    await store.saveBatch(batch(svc, [cluster(svc, "fp", { countsPerMinute: { [minute]: 2 } })]));
    await store.saveBatch(batch(svc, [cluster(svc, "fp", { countsPerMinute: { [minute]: 5 } })]));
    expect(await store.getClusterCounts(svc, "fp", ...ALL_TIME)).toEqual({ [minute]: 7 });
  });

  it("keeps the earliest first_seen, latest last_seen, and the first 3 examples", async () => {
    const svc = "seen";
    await store.saveBatch(
      batch(svc, [cluster(svc, "fp", { firstSeen: "2026-03-06T10:00:00.000Z", lastSeen: "2026-03-06T11:00:00.000Z", examples: ["a", "b"] })]),
    );
    await store.saveBatch(
      batch(svc, [cluster(svc, "fp", { firstSeen: "2026-03-06T09:00:00.000Z", lastSeen: "2026-03-06T10:30:00.000Z", examples: ["b", "c", "d"] })]),
    );
    const stored = await store.getCluster(svc, "fp");
    expect(stored?.firstSeen).toBe("2026-03-06T09:00:00.000Z");
    expect(stored?.lastSeen).toBe("2026-03-06T11:00:00.000Z");
    expect(stored?.examples).toEqual(["a", "b", "c"]);
  });

  it("refuses a cluster that belongs to another service", async () => {
    await expect(store.saveBatch(batch("svc-a", [cluster("svc-b", "fp")]))).rejects.toThrow(/svc-b/);
  });
});

describe("reads", () => {
  it("getBaselineFingerprints returns groups seen in the window before a time", async () => {
    const svc = "baseline";
    await store.saveBatch(
      batch(svc, [
        cluster(svc, "old", { countsPerMinute: { "2026-03-05T12:00:00.000Z": 1 } }),
        cluster(svc, "too-old", { countsPerMinute: { "2026-02-01T12:00:00.000Z": 1 } }),
        cluster(svc, "same-minute-as-deploy", { countsPerMinute: { "2026-03-06T14:00:00.000Z": 1 } }),
        cluster(svc, "after", { countsPerMinute: { "2026-03-06T15:00:00.000Z": 1 } }),
      ]),
    );
    expect(await store.getBaselineFingerprints(svc, "2026-03-06T14:00:30.000Z", 7)).toEqual(["old"]);
  });

  it("getClusterCounts returns only minutes in [from, to)", async () => {
    const svc = "range";
    await store.saveBatch(batch(svc, [cluster(svc, "fp")]));
    expect(await store.getClusterCounts(svc, "fp", "2026-03-06T14:01:00Z", "2026-03-06T14:02:00Z")).toEqual({
      "2026-03-06T14:01:00.000Z": 3,
    });
  });

  it("stores a command bookmark (last timestamp only)", async () => {
    const svc = "command-bookmark";
    const bookmark: Bookmark = { sourceKey: "docker logs api", lastTimestamp: "2026-03-06T14:00:00.000Z" };
    await store.saveBatch(batch(svc, [], bookmark));
    expect(await store.getBookmark(svc, bookmark.sourceKey)).toEqual(bookmark);
  });
});

describe("deploys", () => {
  it("saveDeploy twice gives one row", async () => {
    const deploy = { service: "deploys", sha: "c0d9b9a", previousSha: "6de45eb", time: "2026-03-06T14:00:00.000Z", source: "git" };
    expect(await store.saveDeploy(deploy)).toBe(true);
    expect(await store.saveDeploy(deploy)).toBe(false);
    expect(await store.listDeploys("deploys")).toEqual([deploy]);
  });
});

describe("withRunLock", () => {
  it('gives a second caller "busy" while the first holds the lock', async () => {
    const other = await openStore(testUrl(), { schema }); // like a second cron process
    try {
      const first = await store.withRunLock("locked", async () => {
        const second = await other.withRunLock("locked", async () => "ran");
        const otherService = await other.withRunLock("unlocked", async () => "ran");
        return { second, otherService };
      });
      expect(first).toEqual({ second: "busy", otherService: "ran" });
      // Released afterwards.
      expect(await other.withRunLock("locked", async () => "ran")).toBe("ran");
    } finally {
      await other.close();
    }
  });

  it("releases the lock when the work throws", async () => {
    await expect(store.withRunLock("throws", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await store.withRunLock("throws", async () => "ran")).toBe("ran");
  });
});

describe("end to end on the fixture", () => {
  let fx: Fixture;
  const svc = "shopfront";

  beforeAll(() => {
    fx = buildFixture("direct");
  }, 30_000);
  afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  it("parses, clusters, saves, and reads back the right answer", async () => {
    const read = await readFile(fx.logPath);
    const { clusters, state } = buildClusters(parseLines(read.lines).entries, svc);
    await store.saveBatch({ service: svc, clusters, minerState: state, bookmark: { sourceKey: fx.logPath, file: read.next } });

    // The background DB timeout: one group, counts on every day.
    const db = clusters.find((c) => c.template.includes("DB timeout"))!;
    const counts = await store.getClusterCounts(svc, db.fingerprint, ...ALL_TIME);
    expect(new Set(Object.keys(counts).map((m) => m.slice(0, 10))).size).toBe(10);
    const raw = readFileSync(fx.logPath, "utf8").split("\n").filter((l) => l.includes(BACKGROUND_ERROR)).length;
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(raw);

    // The planted bug: first seen exactly when expected.json says.
    const bug = clusters.find((c) => c.exceptionType === "TypeError")!;
    const stored = await store.getCluster(svc, bug.fingerprint);
    expect(stored?.firstSeen).toBe(fx.expected.errorFirstSeen);
    expect(stored?.topFrames[0]?.fn).toBe("createOrder");

    // Only redacted examples were stored.
    for (const c of clusters) {
      for (const e of (await store.getCluster(svc, c.fingerprint))!.examples) {
        expect(e).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
        expect(e).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
      }
    }
    expect(await store.getBookmark(svc, fx.logPath)).toEqual({ sourceKey: fx.logPath, file: read.next });
  }, 30_000);
});
