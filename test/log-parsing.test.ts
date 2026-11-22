// Tests the log parsers: each format on a small hand-written sample, and the
// text parser on the fixture's app.log.
import { readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectFormat } from "../src/log-parsing/detect-log-format.js";
import { parseJson } from "../src/log-parsing/json-log-format.js";
import type { LogEntry } from "../src/log-parsing/log-entry-types.js";
import { parseNginx } from "../src/log-parsing/nginx-log-format.js";
import { parseLines } from "../src/log-parsing/parse-log-lines.js";
import { lineTimestamp } from "../src/log-parsing/read-line-timestamp.js";
import { parseText } from "../src/log-parsing/text-log-format.js";
import { BACKGROUND_ERROR, buildFixture, type Fixture } from "./fixture/build.js";

const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const EMAIL = /[\w.+-]+@[\w-]+\.\w+/;

// Every piece of text an entry carries, for "no secret leaked" checks.
const allText = (e: LogEntry) => [e.message, ...e.frames.flatMap((f) => [f.file, f.fn ?? ""])].join("\n");

describe("parse the fixture app.log", () => {
  let fx: Fixture;
  let raw: string[];

  beforeAll(() => {
    fx = buildFixture("direct");
    raw = readFileSync(fx.logPath, "utf8").split("\n");
  }, 30_000);
  afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  it("detects the text format and skips nothing", () => {
    expect(detectFormat(raw.slice(0, 200))).toBe("text");
    expect(parseLines(raw).skipped).toBe(0);
  });

  it("keeps one entry per ERROR line and drops INFO", () => {
    const { entries } = parseLines(raw);
    const errorLines = raw.filter((l) => / ERROR /.test(l));
    const infoLines = raw.filter((l) => / INFO /.test(l));
    expect(infoLines.length).toBeGreaterThan(1000);
    expect(entries.length).toBe(errorLines.length);
    for (const e of entries) expect(e.level).toBe("ERROR");
    expect(entries.some((e) => e.message.includes("logged in"))).toBe(false);
  });

  it("keeps the background DB timeout errors", () => {
    const { entries } = parseLines(raw);
    const expected = raw.filter((l) => l.includes(BACKGROUND_ERROR)).length;
    expect(expected).toBeGreaterThan(10);
    expect(entries.filter((e) => e.message.includes(BACKGROUND_ERROR)).length).toBe(expected);
  });

  it("makes the planted error ONE entry with its stack frames", () => {
    const { entries } = parseLines(raw);
    const planted = entries.filter((e) => e.message.includes("TypeError:"));
    // Same number of entries as stack traces in the file: no "at ..." line became its own entry.
    expect(planted.length).toBe(raw.filter((l) => l.startsWith("TypeError:")).length);
    expect(entries.some((e) => /^\s*at /m.test(e.message))).toBe(false);

    // The top frame's line number is the one written in the log.
    const topLine = raw.find((l) => l.includes("at createOrder ("))!;
    const lineNumber = Number(/service\.ts:(\d+):/.exec(topLine)![1]);

    const first = planted[0]!;
    expect(first.timestamp).toBe(fx.expected.errorFirstSeen);
    expect(first.message).toMatch(/^\[api\] POST \/api\/orders failed .*\nTypeError: Cannot read properties of undefined \(reading 'amount'\)$/);
    expect(first.frames).toHaveLength(5);
    expect(first.frames[0]).toEqual({ fn: "createOrder", file: "/app/src/orders/service.ts", line: lineNumber });
    expect(first.frames[1]).toMatchObject({ fn: "handleCreateOrder", file: "/app/src/api/handlers.ts" });
    expect(first.file).toBe("/app/src/orders/service.ts");
    expect(first.lineNumber).toBe(lineNumber);
  });

  it("redacts IPs and emails before anything leaves the parser", () => {
    const { entries } = parseLines(raw);
    expect(raw.some((l) => / ERROR .*ip=\d/.test(l))).toBe(true); // the raw log does have IPs
    for (const e of entries) {
      expect(allText(e)).not.toMatch(IPV4);
      expect(allText(e)).not.toMatch(EMAIL);
    }
    expect(entries.some((e) => e.message.includes("ip=<ip>"))).toBe(true);
  });
});

describe("text format", () => {
  const sample = [
    "2026-03-06T14:00:00.000Z INFO  [api] GET /health 200",
    "2026-03-06T14:00:01.000Z DEBUG cache warm",
    "2026-03-06T14:00:02.500Z WARN [db] slow query 812ms for bob@example.com",
    "2026-03-06 14:00:03 [ERROR] request failed from 198.51.100.7",
    "Error: boom",
    "    at handler (/srv/app/src/api.ts:42:7)",
    "    at async Promise.all (index 0)",
    "    at /srv/app/src/server.ts:10:3",
    "%%% garbage that is not a log line %%%",
    "2026-13-45T99:99:99Z ERROR impossible time",
    "",
    "2026-03-06T14:00:04+02:00 error: second error",
  ];

  it("parses levels, timestamps, stacks, and skips garbage", () => {
    const { entries, skipped } = parseText(sample);
    expect(skipped).toBe(2); // the garbage line and the impossible time
    expect(entries).toEqual([
      {
        timestamp: "2026-03-06T14:00:02.500Z",
        level: "WARN",
        message: "[db] slow query 812ms for <email>",
        frames: [],
      },
      {
        timestamp: "2026-03-06T14:00:03.000Z", // no zone: treated as UTC
        level: "ERROR",
        message: "request failed from <ip>\nError: boom",
        frames: [
          { fn: "handler", file: "/srv/app/src/api.ts", line: 42 },
          { file: "/srv/app/src/server.ts", line: 10 },
        ],
        file: "/srv/app/src/api.ts",
        lineNumber: 42,
      },
      {
        timestamp: "2026-03-06T12:00:04.000Z",
        level: "ERROR",
        message: "second error",
        frames: [],
      },
    ]);
  });

  it("ignores stack lines under a dropped INFO line", () => {
    const { entries, skipped } = parseText([
      "2026-03-06T14:00:00Z INFO handled error",
      "Error: expected",
      "    at f (/a.ts:1:1)",
    ]);
    expect(entries).toEqual([]);
    expect(skipped).toBe(0);
  });

  it("counts a stack line with no entry before it as skipped", () => {
    expect(parseText(["    at f (/a.ts:1:1)"]).skipped).toBe(1);
  });

  it("is detected", () => expect(detectFormat(sample)).toBe("text"));
});

describe("json format", () => {
  const sample = [
    '{"time":"2026-03-06T14:00:00Z","level":"info","msg":"listening"}',
    '{"time":"2026-03-06T14:00:01.250Z","level":"error","msg":"payment failed","err":{"message":"card declined","stack":"Error: card declined for 4111 1111 1111 1111\\n    at charge (/app/src/pay.ts:7:11)\\n    at main (/app/src/index.ts:3:1)"}}',
    '{"time":1772805602000,"level":40,"msg":"retrying user=ann@example.org"}',
    '{"timestamp":"2026-03-06T14:00:03Z","severity":"ERROR","message":"crashed"}',
    "    at handle (/app/src/http.ts:99:2)",
    '{"time":"2026-03-06T14:00:04Z","level":"error","msg": broken json',
    "not json at all",
    '{"level":"error","msg":"no time"}',
    "[1, 2, 3]",
  ];

  it("parses fields, stack field, pino levels, continuation lines; skips garbage", () => {
    const { entries, skipped } = parseJson(sample);
    expect(skipped).toBe(4); // broken json, not json, no time, array
    expect(entries).toEqual([
      {
        timestamp: "2026-03-06T14:00:01.250Z",
        level: "ERROR",
        message: "payment failed\nError: card declined for <card>",
        frames: [
          { fn: "charge", file: "/app/src/pay.ts", line: 7 },
          { fn: "main", file: "/app/src/index.ts", line: 3 },
        ],
        file: "/app/src/pay.ts",
        lineNumber: 7,
      },
      {
        timestamp: "2026-03-06T14:00:02.000Z", // pino: Unix ms, level 40 = warn
        level: "WARN",
        message: "retrying user=<email>",
        frames: [],
      },
      {
        timestamp: "2026-03-06T14:00:03.000Z",
        level: "ERROR",
        message: "crashed",
        frames: [{ fn: "handle", file: "/app/src/http.ts", line: 99 }],
        file: "/app/src/http.ts",
        lineNumber: 99,
      },
    ]);
  });

  it("is detected", () => expect(detectFormat(sample)).toBe("json"));
});

describe("nginx format", () => {
  const sample = [
    '2026/03/06 14:00:00 [error] 1234#0: *5678 upstream timed out (110: Connection timed out) while reading response header from upstream, client: 203.0.113.9, server: shop.example.com, request: "GET /api/orders HTTP/1.1"',
    "2026/03/06 14:00:01 [warn] 1234#0: *5679 an upstream response is buffered to a temporary file",
    "2026/03/06 14:00:02 [notice] 1234#0: signal process started",
    '203.0.113.9 - - [06/Mar/2026:14:00:03 +0000] "GET /api/orders HTTP/1.1" 200 512 "-" "curl/8.0"',
    '203.0.113.9 - - [06/Mar/2026:14:00:04 +0000] "GET /missing HTTP/1.1" 404 0 "-" "curl/8.0"',
    '2001:db8::7 - - [06/Mar/2026:16:00:05 +0200] "POST /api/orders HTTP/1.1" 502 157 "-" "Mozilla/5.0"',
    "<<< garbage >>>",
  ];

  it("keeps error/warn and 5xx, drops the rest, skips garbage", () => {
    const { entries, skipped } = parseNginx(sample);
    expect(skipped).toBe(1);
    expect(entries).toEqual([
      {
        timestamp: "2026-03-06T14:00:00.000Z",
        level: "ERROR",
        message:
          'upstream timed out (110: Connection timed out) while reading response header from upstream, client: <ip>, server: shop.example.com, request: "GET /api/orders HTTP/1.1"',
        frames: [],
      },
      {
        timestamp: "2026-03-06T14:00:01.000Z",
        level: "WARN",
        message: "an upstream response is buffered to a temporary file",
        frames: [],
      },
      {
        timestamp: "2026-03-06T14:00:05.000Z",
        level: "ERROR",
        message: '"POST /api/orders HTTP/1.1" 502',
        frames: [],
      },
    ]);
  });

  it("is detected", () => expect(detectFormat(sample)).toBe("nginx"));
});

describe("lineTimestamp", () => {
  it("reads a timestamp from any format, and none from stack lines", () => {
    expect(lineTimestamp("2026-03-06T14:00:00Z INFO x")).toBe("2026-03-06T14:00:00.000Z");
    expect(lineTimestamp('{"time":"2026-03-06T14:00:00Z","level":"debug"}')).toBe("2026-03-06T14:00:00.000Z");
    expect(lineTimestamp("2026/03/06 14:00:00 [info] 1#0: x")).toBe("2026-03-06T14:00:00.000Z");
    expect(lineTimestamp("2026-03-06T14:00:00Z SOMETHING odd")).toBe("2026-03-06T14:00:00.000Z");
    expect(lineTimestamp("    at f (/a.ts:1:1)")).toBeUndefined();
  });
});

describe("parseLines and the redact setting", () => {
  it("redacts only the configured kinds in messages", () => {
    const lines = ["2026-03-06T14:04:00Z ERROR login failed for jane@example.com from 203.0.113.9"];
    expect(parseLines(lines).entries[0]!.message).toBe("login failed for <email> from <ip>");
    expect(parseLines(lines, undefined, ["email"]).entries[0]!.message).toBe("login failed for <email> from 203.0.113.9");
    expect(parseLines(lines, "text", ["ip"]).entries[0]!.message).toBe("login failed for jane@example.com from <ip>");
  });
});
