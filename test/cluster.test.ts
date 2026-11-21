
import { readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMessage, buildClusters, emptyState, exportState, importState, normalize, type MinerState } from "../src/cluster.js";
import { parseLines, type LogEntry } from "../src/parse/index.js";
import { BACKGROUND_ERROR, buildFixture, type Fixture } from "./fixture/build.js";

const msg = (message: string, timestamp = "2026-03-06T14:00:00.000Z"): LogEntry => ({ timestamp, level: "ERROR", message, frames: [] });

const crash = (frames: { file: string; fn: string; line: number }[], timestamp = "2026-03-06T14:00:00.000Z"): LogEntry => ({
  timestamp,
  level: "ERROR",
  message: "request failed\nTypeError: Cannot read properties of undefined (reading 'amount')",
  frames,
  file: frames[0]!.file,
  lineNumber: frames[0]!.line,
});

const fingerprints = (entries: LogEntry[], service = "api") => buildClusters(entries, service).clusters.map((c) => c.fingerprint);

describe("normalize", () => {
  it("masks UUIDs", () => {
    expect(normalize("request b6f3dd1a-9f2e-48fc-b778-86bda6a59506 failed")).toBe("request <uuid> failed");
  });

  it("masks hex strings", () => {
    expect(normalize("commit 3ace284f9d failed at 0x7ffd1a2b, order ord_8f3a2b1c")).toBe("commit <hex> failed at <hex>, order ord_<hex>");
  });

  it("masks IP addresses", () => {
    expect(normalize("peer 10.0.0.12 and 2001:db8::1 closed")).toBe("peer <ip> and <ip> closed");
  });

  it("masks URL query strings", () => {
    expect(normalize("GET /search?q=shoes&page=2 slow")).toBe("GET /search?<query> slow");
  });

  it("masks ID-like path parts", () => {
    expect(normalize("GET /orders/8841/items failed")).toBe("GET /orders/<id>/items failed");
    expect(normalize("GET /api/v1/orders/ord_8f3a2b1c")).toBe("GET /api/v1/orders/<id>");
    expect(normalize("GET /users/b6f3dd1a-9f2e-48fc-b778-86bda6a59506")).toBe("GET /users/<uuid>");
  });

  it("masks plain numbers, including durations", () => {
    expect(normalize("Timeout for user 123")).toBe("Timeout for user <num>");
    expect(normalize("DB timeout after 5000ms, took 1.5s, user=u_48818")).toBe("DB timeout after <num>ms, took <num>s, user=u_<num>");
  });

  it("makes the same error with different values identical", () => {
    expect(normalize("Timeout for user 123")).toBe(normalize("Timeout for user 456"));
  });

  it("keeps redaction placeholders and leaves clean text unchanged", () => {
    const clean = "Connection refused by upstream for <email> with <token> from <ip> paying <card> using sha256 v1.2.3";
    expect(normalize(clean)).toBe(clean);
    expect(normalize("Nothing to mask here")).toBe("Nothing to mask here");
  });
});

describe("fingerprints", () => {
  it("gives the same error with different IDs, UUIDs and IPs one fingerprint", () => {
    const fps = fingerprints([
      msg("Payment failed for order 8841 request_id=b6f3dd1a-9f2e-48fc-b778-86bda6a59506 ip=10.0.0.1"),
      msg("Payment failed for order 1203 request_id=0c1d2e3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5 ip=192.168.4.20"),
      msg("Payment failed for order 7 request_id=11111111-2222-4333-8444-555555555555 ip=<ip>"),
    ]);
    expect(fps).toHaveLength(1);
    expect(fps[0]).toMatch(/^[0-9a-f]{12}$/);
  });

  it("gives the same message in two services different fingerprints", () => {
    const entry = msg("DB timeout after 5000ms");
    expect(fingerprints([entry], "api")).not.toEqual(fingerprints([entry], "worker"));

    const stack = crash([{ file: "/app/src/a.ts", fn: "f", line: 1 }]);
    expect(fingerprints([stack], "api")).not.toEqual(fingerprints([stack], "worker"));
  });

  it("ignores line numbers in stack frames", () => {
    const before = crash([
      { file: "/app/src/orders/service.ts", fn: "createOrder", line: 19 },
      { file: "/app/src/api/handlers.ts", fn: "handleCreateOrder", line: 16 },
    ]);
    const shifted = crash([
      { file: "/app/src/orders/service.ts", fn: "createOrder", line: 20 },
      { file: "/app/src/api/handlers.ts", fn: "handleCreateOrder", line: 18 },
    ]);
    const result = buildClusters([before, shifted], "api");
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.exceptionType).toBe("TypeError");
    expect(result.clusters[0]!.sourceRefs).toEqual(["/app/src/orders/service.ts:19", "/app/src/orders/service.ts:20"]);
  });

  it("gives a different top frame a different fingerprint", () => {
    const a = crash([{ file: "/app/src/orders/service.ts", fn: "createOrder", line: 20 }]);
    const b = crash([{ file: "/app/src/orders/service.ts", fn: "cancelOrder", line: 20 }]);
    const c = crash([{ file: "/app/src/users/repo.ts", fn: "createOrder", line: 20 }]);
    expect(new Set(fingerprints([a, b, c])).size).toBe(3);
  });
});

describe("template miner", () => {
  it("merges messages that differ in a word slot", () => {
    const { clusters } = buildClusters(
      [msg("User alice not found in shard east"), msg("User bob not found in shard west")],
      "api",
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.template).toBe("User <*> not found in shard <*>");
  });

  it("keeps clearly different messages apart", () => {
    const { clusters } = buildClusters([msg("User alice not found in shard east"), msg("User alice was deleted by an admin today")], "api");
    expect(clusters).toHaveLength(2);
  });

  it("never changes a group's fingerprint once it is created", () => {
    const first = "User alice not found in shard east";
    const start = buildClusters([msg(first)], "api");
    const fingerprint = start.clusters[0]!.fingerprint;

    // Many more messages that make the template more general, run after run,
    // with the state saved as JSON in between.
    let state: MinerState = start.state;
    const names = ["bob", "carol", "dave", "erin", "frank", "grace", "heidi"];
    const shards = ["west", "north", "south", "eu-1", "us-2", "ap-3", "sa-4"];
    for (let run = 0; run < 5; run++) {
      const batch = names.map((n, i) => msg(`User ${n} not found in shard ${shards[(i + run) % shards.length]}`));
      batch.push(msg("Something unrelated happened to the cache"));
      state = JSON.parse(JSON.stringify(buildClusters(batch, "api", state).state)) as MinerState;
    }

    const again = buildClusters([msg(first), msg("User zoe not found in shard moon")], "api", state);
    expect(again.clusters).toHaveLength(1);
    expect(again.clusters[0]!.fingerprint).toBe(fingerprint);
    expect(again.clusters[0]!.template).toBe("User <*> not found in shard <*>");
  });

  it("exports plain JSON and imports it back", () => {
    const miner = importState(emptyState());
    const group = addMessage(miner, "api", "Cache miss for key <num>");
    const state = exportState(miner);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(addMessage(importState(state), "api", "Cache miss for key <num>").fingerprint).toBe(group.fingerprint);
  });

  it("does not change the state passed in", () => {
    const { state } = buildClusters([msg("User alice not found in shard east")], "api");
    const copy = JSON.parse(JSON.stringify(state));
    buildClusters([msg("User bob not found in shard west")], "api", state);
    expect(state).toEqual(copy);
  });
});

describe("buildClusters on the fixture app.log", () => {
  let fx: Fixture;
  let entries: LogEntry[];

  beforeAll(() => {
    fx = buildFixture("direct");
    entries = parseLines(readFileSync(fx.logPath, "utf8").split("\n")).entries;
  }, 30_000);
  afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  it("makes the background DB timeout ONE group with counts on every day", () => {
    const { clusters } = buildClusters(entries, "shopfront");
    const db = clusters.filter((c) => c.template.includes(BACKGROUND_ERROR.replace("5000", "<num>")));
    expect(db).toHaveLength(1);
    const days = new Set(Object.keys(db[0]!.countsPerMinute).map((m) => m.slice(0, 10)));
    expect(days.size).toBe(10);
    const total = Object.values(db[0]!.countsPerMinute).reduce((a, b) => a + b, 0);
    expect(total).toBe(entries.filter((e) => e.message.includes(BACKGROUND_ERROR)).length);
  });

  it("makes the planted bug ONE group, first seen when expected.json says", () => {
    const { clusters } = buildClusters(entries, "shopfront");
    expect(clusters).toHaveLength(2); // background error + planted bug, nothing else
    const bug = clusters.filter((c) => c.exceptionType === "TypeError");
    expect(bug).toHaveLength(1);
    expect(bug[0]!.firstSeen).toBe(fx.expected.errorFirstSeen);
    expect(bug[0]!.topFrames.map((f) => f.fn)).toEqual(["createOrder", "handleCreateOrder", "Layer.handle [as handle_request]"]);
    expect(bug[0]!.sourceRefs).toHaveLength(1);
    expect(bug[0]!.sourceRefs[0]).toMatch(/^\/app\/src\/orders\/service\.ts:\d+$/);
  });

  it("keeps at most 3 examples, with no emails or IPs", () => {
    const { clusters } = buildClusters(entries, "shopfront");
    for (const c of clusters) {
      expect(c.examples.length).toBeGreaterThan(0);
      expect(c.examples.length).toBeLessThanOrEqual(3);
      for (const e of c.examples) {
        expect(e).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
        expect(e).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      }
    }
  });

  it("is deterministic: same input twice gives identical output", () => {
    expect(buildClusters(entries, "shopfront")).toEqual(buildClusters(entries, "shopfront"));
    expect(JSON.stringify(buildClusters(entries, "shopfront"))).toBe(JSON.stringify(buildClusters(entries, "shopfront")));
  });
});
