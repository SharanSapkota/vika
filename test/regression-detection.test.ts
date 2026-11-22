// Tests the regression detector: the fixture scenarios, plus small hand-made
// cases for each rule. No Postgres.
import { readFileSync, rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { buildClusters } from "../src/error-grouping/build-clusters.js";
import { detectRegressions } from "../src/regression-detection/detect-regressions.js";
import type { DetectCluster, DetectDeploy, DetectInput } from "../src/regression-detection/detection-types.js";
import { parseLines } from "../src/log-parsing/parse-log-lines.js";
import { BACKGROUND_ERROR, buildFixture, type Fixture } from "./fixture/build.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const D = Date.parse("2026-03-10T12:00:00.000Z"); // the deploy under test
const iso = (ms: number) => new Date(ms).toISOString();

// A cluster from a list of event times (epoch ms).
function group(fingerprint: string, times: number[], service?: string): DetectCluster {
  const countsPerMinute: Record<string, number> = {};
  for (const t of times) {
    const key = iso(Math.floor(t / MINUTE) * MINUTE);
    countsPerMinute[key] = (countsPerMinute[key] ?? 0) + 1;
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    fingerprint,
    countsPerMinute,
    firstSeen: iso(sorted[0]!),
    lastSeen: iso(sorted.at(-1)!),
    ...(service === undefined ? {} : { service }),
  };
}

// `count` events evenly spaced from `from` for `hours` hours.
function steady(from: number, hours: number, perHour: number): number[] {
  const n = Math.round(hours * perHour);
  return Array.from({ length: n }, (_, i) => from + Math.floor((i * hours * HOUR) / n));
}

// `n` events one minute apart, starting at `from`.
function burst(from: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + i * MINUTE);
}

function deploy(sha: string, time: number, service?: string): DetectDeploy {
  return { sha, previousSha: "prev-" + sha, time: iso(time), ...(service === undefined ? {} : { service }) };
}

// A plain input with 8 days of history before D and data until D + 6h.
function input(clusters: DetectCluster[], deploys: DetectDeploy[] = [deploy("bad", D)], extra: Partial<DetectInput> = {}): DetectInput {
  return {
    service: "shopfront",
    deploys,
    clusters,
    historyStart: iso(D - 8 * 24 * HOUR),
    dataEnd: iso(D + 6 * HOUR),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Fixture scenarios
// ---------------------------------------------------------------------------

const fixtures: Fixture[] = [];
afterAll(() => {
  for (const fx of fixtures) rmSync(fx.root, { recursive: true, force: true });
});

describe.each(["direct", "indirect"] as const)("fixture: %s", (scenario) => {
  const fx = buildFixture(scenario);
  fixtures.push(fx);
  const entries = parseLines(readFileSync(fx.logPath, "utf8").split("\n")).entries;
  const { clusters } = buildClusters(entries, "shopfront");
  const deploys = fx.deploys.map((d) => ({ ...d, service: "shopfront" }));
  const result = detectRegressions({ service: "shopfront", deploys, clusters });

  it("finds exactly 1 regression, on the bad deploy, with the right group and first seen", () => {
    const planted = clusters.find((c) => c.exceptionType === "TypeError")!;
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toMatchObject({
      fingerprint: planted.fingerprint,
      deploySha: fx.expected.badDeploySha,
      kind: "new",
      firstSeen: fx.expected.errorFirstSeen,
      baselineRate: 0,
      ambiguous: false,
      restoredAt: null, // it never stops in the fixture log
    });
    expect(result.regressions[0]!.occurrences).toBeGreaterThanOrEqual(5);
  });

  it("never flags the DB timeout background error", () => {
    const db = clusters.find((c) => c.template.includes(BACKGROUND_ERROR.replace("5000", "<num>")))!;
    expect(db).toBeDefined();
    expect(result.regressions.map((r) => r.fingerprint)).not.toContain(db.fingerprint);
  });

  it("marks only the bad deploy as failed; the first deploy is a starting point", () => {
    expect(result.deploys.map((d) => d.deploySha)).toEqual(fx.deploys.map((d) => d.sha));
    expect(result.deploys[0]!.status).toBe("starting_point");
    expect(result.deploys.filter((d) => d.failed).map((d) => d.deploySha)).toEqual([fx.expected.badDeploySha]);
  });
});

// ---------------------------------------------------------------------------
// Rules on hand-made data
// ---------------------------------------------------------------------------

describe("cold start", () => {
  it('only 6 hours of history gives "insufficient_baseline" and flags nothing', () => {
    const result = detectRegressions(input([group("new-error", burst(D + 5 * MINUTE, 20))], undefined, { historyStart: iso(D - 6 * HOUR) }));
    expect(result.deploys).toEqual([{ deploySha: "bad", time: iso(D), status: "insufficient_baseline", failed: false }]);
    expect(result.regressions).toEqual([]);
  });

  it("without historyStart, uses the earliest data point", () => {
    const early = group("background", [D - 6 * HOUR, D + 3 * HOUR]);
    const result = detectRegressions(input([early, group("new-error", burst(D + 5 * MINUTE, 20))], undefined, { historyStart: undefined }));
    expect(result.deploys[0]!.status).toBe("insufficient_baseline");
  });
});

describe("spike", () => {
  const baselineStart = D - 7 * 24 * HOUR;

  it("flags a group going from 1/hour to 50/hour", () => {
    const times = [...steady(baselineStart, 7 * 24, 1), ...steady(D, 2, 50)];
    const result = detectRegressions(input([group("spiky", times)]));
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toMatchObject({ fingerprint: "spiky", kind: "spike", deploySha: "bad", baselineRate: 1 });
    expect(result.regressions[0]!.postRate).toBeGreaterThan(10);
  });

  it("does not flag a group going from 100/hour to 110/hour", () => {
    const times = [...steady(baselineStart, 7 * 24, 100), ...steady(D, 6, 110)];
    expect(detectRegressions(input([group("busy", times)])).regressions).toEqual([]);
  });

  it("does not flag a steady background error", () => {
    const times = steady(baselineStart, 7 * 24 + 6, 0.2); // about 5 a day, before and after
    expect(detectRegressions(input([group("db-timeout", times)])).regressions).toEqual([]);
  });
});

describe("new groups", () => {
  it("is flagged when it starts within the window and has enough occurrences", () => {
    const result = detectRegressions(input([group("fresh", burst(D + 4 * MINUTE, 10))]));
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toMatchObject({ kind: "new", firstSeen: iso(D + 4 * MINUTE), occurrences: 10, baselineRate: 0 });
  });

  it("is NOT attributed to a deploy 2 hours earlier", () => {
    expect(detectRegressions(input([group("late", burst(D + 2 * HOUR, 20))])).regressions).toEqual([]);
  });

  it("is NOT flagged with fewer than minCount occurrences", () => {
    expect(detectRegressions(input([group("rare", burst(D + 5 * MINUTE, 4))])).regressions).toEqual([]);
  });

  it("is NOT a new group if it was already in the baseline window (only the spike rule can apply)", () => {
    const result = detectRegressions(input([group("old", [D - 2 * 24 * HOUR, ...burst(D + 5 * MINUTE, 10)])]));
    expect(result.regressions.map((r) => r.kind)).toEqual(["spike"]);

    // Seen as often before the deploy as after: nothing at all.
    const steadyish = [...steady(D - 7 * 24 * HOUR, 7 * 24, 20), ...steady(D, 6, 20)];
    expect(detectRegressions(input([group("same-rate", steadyish)])).regressions).toEqual([]);
  });

  it("uses older baseline counts from the store (same minute in both: no double counting)", () => {
    const cluster = group("seen-before", burst(D + 5 * MINUTE, 10));
    const baseline = { "seen-before": { [iso(D - 3 * 24 * HOUR)]: 1, [iso(D + 5 * MINUTE)]: 1 } };
    const result = detectRegressions(input([cluster], undefined, { baseline }));
    // It existed 3 days ago, so it isn't new. Once in 3 days -> 10 right after
    // the deploy is a spike, and the shared minute is counted once (10, not 11).
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toMatchObject({ kind: "spike", occurrences: 10, firstSeen: iso(D + 5 * MINUTE) });
  });
});

describe("overlapping deploys", () => {
  it("picks the latest deploy before first seen and sets ambiguous", () => {
    const deploys = [deploy("first", D), deploy("second", D + 10 * MINUTE)];
    const result = detectRegressions(input([group("fresh", burst(D + 15 * MINUTE, 10))], deploys));
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toMatchObject({ deploySha: "second", ambiguous: true });
  });

  it("is not ambiguous when the deploys are far apart", () => {
    const deploys = [deploy("first", D - 5 * HOUR), deploy("second", D)];
    const result = detectRegressions(input([group("fresh", burst(D + 15 * MINUTE, 10))], deploys));
    expect(result.regressions[0]).toMatchObject({ deploySha: "second", ambiguous: false });
  });
});

describe("one service at a time", () => {
  it("never blames another service's deploy", () => {
    const deploys = [deploy("shop-deploy", D, "shopfront"), deploy("pay-deploy", D + 10 * MINUTE, "payments")];
    const errors = group("shop-error", burst(D + 15 * MINUTE, 10), "shopfront");

    const shop = detectRegressions(input([errors], deploys));
    expect(shop.regressions.map((r) => r.deploySha)).toEqual(["shop-deploy"]);
    expect(shop.deploys.map((d) => d.deploySha)).toEqual(["shop-deploy"]);
    expect(shop.regressions[0]!.ambiguous).toBe(false); // the payments deploy doesn't count

    const pay = detectRegressions(input([errors], deploys, { service: "payments" }));
    expect(pay.regressions).toEqual([]);
  });
});

describe("restore time", () => {
  it("is the minute after the error stops, once it has stayed quiet", () => {
    const times = burst(D + 5 * MINUTE, 20); // last one at D + 24 min
    const result = detectRegressions(input([group("fixed-later", times)]));
    expect(result.regressions[0]!.restoredAt).toBe(iso(D + 25 * MINUTE));
  });

  it("is null when the error continues to the end of the data", () => {
    const times = steady(D + 5 * MINUTE, 6, 10).filter((t) => t < D + 6 * HOUR);
    expect(detectRegressions(input([group("ongoing", times)])).regressions[0]!.restoredAt).toBeNull();
  });

  it("is null when the quiet period isn't long enough yet", () => {
    const times = burst(D + 5 * MINUTE, 20);
    const result = detectRegressions(input([group("too-soon", times)], undefined, { dataEnd: iso(D + 40 * MINUTE) }));
    expect(result.regressions[0]!.restoredAt).toBeNull();
  });

  it("for a spike, is when the rate is back to the baseline level", () => {
    const baselineStart = D - 7 * 24 * HOUR;
    const times = [...steady(baselineStart, 7 * 24, 1), ...steady(D, 1, 60), ...steady(D + HOUR, 5, 1)];
    const r = detectRegressions(input([group("spike-then-calm", times)])).regressions[0]!;
    expect(r.kind).toBe("spike");
    expect(Date.parse(r.restoredAt!)).toBeGreaterThan(D + 50 * MINUTE);
    expect(Date.parse(r.restoredAt!)).toBeLessThanOrEqual(D + 61 * MINUTE);
  });
});

describe("severity and failed", () => {
  it("low severity does not fail the deploy; medium does", () => {
    const low = detectRegressions(input([group("small", burst(D + 5 * MINUTE, 6))]));
    expect(low.regressions[0]!.severity).toBe("low");
    expect(low.deploys[0]!.failed).toBe(false);

    const medium = detectRegressions(input([group("bigger", burst(D + 5 * MINUTE, 25))]));
    expect(medium.regressions[0]!.severity).toBe("medium");
    expect(medium.deploys[0]!.failed).toBe(true);
  });
});

describe("determinism", () => {
  it("same input gives identical output", () => {
    const baselineStart = D - 7 * 24 * HOUR;
    const make = () =>
      input(
        [group("spiky", [...steady(baselineStart, 7 * 24, 1), ...steady(D, 2, 50)]), group("fresh", burst(D + 4 * MINUTE, 10))],
        [deploy("first", D - 10 * MINUTE), deploy("bad", D)],
      );
    const a = detectRegressions(make());
    const b = detectRegressions(make());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.regressions.length).toBe(2);
  });
});
