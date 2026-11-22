// Tests the log parsers: each format on a small hand-written sample, and the
// text parser on the fixture's app.log.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectFormat, recognizeFormat } from "../src/log-parsing/detect-log-format.js";
import { parseJson } from "../src/log-parsing/json-log-format.js";
import type { LogEntry } from "../src/log-parsing/log-entry-types.js";
import { parseNginx } from "../src/log-parsing/nginx-log-format.js";
import { parseLines } from "../src/log-parsing/parse-log-lines.js";
import { readPythonTraceback } from "../src/log-parsing/python-traceback-reader.js";
import { readCommand } from "../src/log-parsing/read-log-command.js";
import { lineTimestamp } from "../src/log-parsing/read-line-timestamp.js";
import { parseText } from "../src/log-parsing/text-log-format.js";
import { BACKGROUND_ERROR, buildFixture, type Fixture } from "./fixture/build.js";
import { REAL_PYTHON_LOG_SAMPLES } from "./fixture/python-log-samples.js";

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

// ---------------------------------------------------------------------------
// Python: the two line shapes, warnings and tracebacks
// ---------------------------------------------------------------------------

const PYTHON_WARNING = [
  "/usr/local/lib/python3.12/site-packages/jwt/api_jwt.py:370: InsecureKeyLengthWarning: The HMAC key is 14 bytes long, which is below the minimum recommended length of 32 bytes for SHA256. See RFC 7518 Section 3.2.",
  "  decoded = self.decode_complete(",
];

describe("Python log lines: the real samples", () => {
  it("drops the INFO lines of both shapes and makes no entries from the Python warning", () => {
    for (const language of ["python", "javascript"] as const) {
      const { format, entries, skipped } = parseLines(REAL_PYTHON_LOG_SAMPLES, undefined, undefined, language);
      expect(format).toBe("text");
      expect(entries).toEqual([]);
      // Python skips the warning line and its indented source line. The
      // unchanged JavaScript rule swallows any indented line under a dropped
      // INFO line, so it skips only the warning line itself.
      expect(skipped).toBe(language === "python" ? 2 : 1);
    }
  });

  it("is recognized as the text format, from both shapes", () => {
    expect(recognizeFormat(REAL_PYTHON_LOG_SAMPLES)).toEqual({ format: "text", recognizedCount: 5 });
  });

  it("reads both shapes' times as UTC; warning lines have no time", () => {
    expect(lineTimestamp("[2026-11-21 19:17:52 +0000] [1] [INFO] Starting gunicorn 27.0.0")).toBe("2026-11-21T19:17:52.000Z");
    expect(lineTimestamp("2026-11-21 19:17:57,987 - server - INFO - Cloudinary reachable")).toBe("2026-11-21T19:17:57.987Z");
    expect(lineTimestamp(PYTHON_WARNING[0]!)).toBeUndefined();
    expect(lineTimestamp(PYTHON_WARNING[1]!)).toBeUndefined();
  });
});

describe("Python log lines: levels in one mixed stream", () => {
  const mixedLines = [
    "[2026-11-21 19:20:00 +0000] [7] [ERROR] Exception in ASGI application",
    "2026-11-21 19:20:01,250 - server - WARNING - Slow upload to Cloudinary 4200ms",
    ...PYTHON_WARNING,
    "[2026-11-21 19:20:02 -0500] [1] [CRITICAL] WORKER TIMEOUT (pid:8)",
    "2026-11-21 19:20:03,004 - server - CRITICAL - Database unreachable",
    "[2026-11-21 19:20:04 +0000] [8] [WARNING] Worker graceful timeout",
    "2026-11-21 19:20:05,999 - server - ERROR - Payment provider said no",
    "2026-11-21 19:20:06,000 - server - DEBUG - cache warm",
    "[2026-11-21 19:20:07 +0000] [8] [NOTICE] not a Python level word",
  ];

  it("keeps ERROR, WARNING (as WARN) and CRITICAL (as ERROR) with UTC times", () => {
    const { entries, skipped } = parseLines(mixedLines, "text", undefined, "python");
    expect(entries.map(({ timestamp, level, message }) => ({ timestamp, level, message }))).toEqual([
      { timestamp: "2026-11-21T19:20:00.000Z", level: "ERROR", message: "Exception in ASGI application" },
      { timestamp: "2026-11-21T19:20:01.250Z", level: "WARN", message: "Slow upload to Cloudinary 4200ms" },
      { timestamp: "2026-11-22T00:20:02.000Z", level: "ERROR", message: "WORKER TIMEOUT (pid:8)" },
      { timestamp: "2026-11-21T19:20:03.004Z", level: "ERROR", message: "Database unreachable" },
      { timestamp: "2026-11-21T19:20:04.000Z", level: "WARN", message: "Worker graceful timeout" },
      { timestamp: "2026-11-21T19:20:05.999Z", level: "ERROR", message: "Payment provider said no" },
    ]);
    // The two warning lines, and the line with a level word Python never writes.
    expect(skipped).toBe(3);
  });

  it("never attaches a warning's indented source line to the error above it", () => {
    const { entries } = parseLines(["2026-11-21 19:20:05,999 - server - ERROR - Payment provider said no", ...PYTHON_WARNING], "text", undefined, "python");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("Payment provider said no");
    expect(entries[0]!.frames).toEqual([]);
  });
});

const SIMPLE_TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/app/src/shop/api/routes.py", line 13, in create_order_route',
  "    return orders.create_order(order)",
  "           ^^^^^^^^^^^^^^^^^^^^^^^^^^",
  '  File "/app/src/shop/orders/service.py", line 22, in create_order',
  "    email = user.email",
  "            ^^^^^^^^^^",
  "AttributeError: 'NoneType' object has no attribute 'email'",
];

describe("readPythonTraceback", () => {
  it("simple: frames come out innermost first; the last line gives type and message", () => {
    expect(readPythonTraceback(SIMPLE_TRACEBACK)).toEqual({
      frames: [
        { file: "/app/src/shop/orders/service.py", line: 22, fn: "create_order" },
        { file: "/app/src/shop/api/routes.py", line: 13, fn: "create_order_route" },
      ],
      messageLines: ["AttributeError: 'NoneType' object has no attribute 'email'"],
      exceptionType: "AttributeError",
    });
  });

  it("nested: a deep call chain keeps every frame, crashing call first", () => {
    const reading = readPythonTraceback([
      "Traceback (most recent call last):",
      '  File "/app/main.py", line 5, in <module>',
      "    run()",
      '  File "/app/main.py", line 2, in run',
      "    step_one()",
      '  File "/app/steps.py", line 9, in step_one',
      "    step_two()",
      '  File "/app/steps.py", line 14, in step_two',
      '    totals["amount"] += 1',
      "KeyError: 'amount'",
    ]);
    expect(reading.frames.map((frame) => `${frame.file}:${frame.line} ${frame.fn}`)).toEqual([
      "/app/steps.py:14 step_two",
      "/app/steps.py:9 step_one",
      "/app/main.py:2 run",
      "/app/main.py:5 <module>",
    ]);
    expect(reading.exceptionType).toBe("KeyError");
    expect(reading.messageLines).toEqual(["KeyError: 'amount'"]);
  });

  it("chained: uses only the final exception's frames, for both chain markers", () => {
    for (const chainMarker of [
      "During handling of the above exception, another exception occurred:",
      "The above exception was the direct cause of the following exception:",
    ]) {
      const reading = readPythonTraceback([
        "Traceback (most recent call last):",
        '  File "/app/src/shop/users/repo.py", line 30, in get_user',
        "    return _users[user_id]",
        "KeyError: 'u_1'",
        "",
        chainMarker,
        "",
        "Traceback (most recent call last):",
        '  File "/app/src/shop/api/routes.py", line 18, in get_user_route',
        "    raise HTTPException(status_code=404)",
        "fastapi.exceptions.HTTPException: 404: Not Found",
      ]);
      expect(reading.frames).toEqual([{ file: "/app/src/shop/api/routes.py", line: 18, fn: "get_user_route" }]);
      expect(reading.exceptionType).toBe("fastapi.exceptions.HTTPException");
      expect(reading.messageLines).toEqual(["fastapi.exceptions.HTTPException: 404: Not Found"]);
    }
  });

  it("dotted exception names, and names that do not end in Error", () => {
    const withLastLine = (lastLine: string) =>
      readPythonTraceback(["Traceback (most recent call last):", '  File "/app/x.py", line 1, in f', "    g()", lastLine]).exceptionType;
    expect(withLastLine("app.errors.PaymentError: card declined")).toBe("app.errors.PaymentError");
    expect(withLastLine("app.errors.PaymentFailed: card declined")).toBe("app.errors.PaymentFailed");
    expect(withLastLine("StopIteration")).toBe("StopIteration");
  });

  it("keeps site-packages, dist-packages and standard-library frames in the entry", () => {
    const reading = readPythonTraceback([
      "Traceback (most recent call last):",
      '  File "/usr/local/lib/python3.12/site-packages/starlette/routing.py", line 74, in app',
      "    response = await f(request)",
      '  File "/usr/lib/python3/dist-packages/requests/api.py", line 59, in request',
      "    return session.request(method=method, url=url, **kwargs)",
      '  File "/usr/local/lib/python3.12/asyncio/tasks.py", line 520, in wait_for',
      "    return await fut",
      "TimeoutError",
    ]);
    expect(reading.frames.map((frame) => frame.file)).toEqual([
      "/usr/local/lib/python3.12/asyncio/tasks.py",
      "/usr/lib/python3/dist-packages/requests/api.py",
      "/usr/local/lib/python3.12/site-packages/starlette/routing.py",
    ]);
    expect(reading.exceptionType).toBe("TimeoutError");
  });

  it("reads a traceback that has no source lines", () => {
    expect(
      readPythonTraceback([
        "Traceback (most recent call last):",
        '  File "<frozen runpy>", line 198, in _run_module_as_main',
        '  File "/app/src/shop/main.py", line 7, in start',
        "ValueError: bad port",
      ]),
    ).toEqual({
      frames: [
        { file: "/app/src/shop/main.py", line: 7, fn: "start" },
        { file: "<frozen runpy>", line: 198, fn: "_run_module_as_main" },
      ],
      messageLines: ["ValueError: bad port"],
      exceptionType: "ValueError",
    });
  });
});

describe("Python tracebacks under an ERROR line", () => {
  it("attach to the entry above them in both shapes, between unrelated lines", () => {
    const { entries, skipped } = parseLines(
      [
        "2026-11-21 20:01:02,345 - server - ERROR - POST /api/orders failed",
        ...SIMPLE_TRACEBACK,
        ...PYTHON_WARNING,
        "[2026-11-21 20:01:03 +0000] [8] [ERROR] Exception in ASGI application",
        ...SIMPLE_TRACEBACK,
        "2026-11-21 20:01:04,000 - server - INFO - still serving",
      ],
      undefined,
      undefined,
      "python",
    );
    expect(skipped).toBe(2); // only the warning
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.frames.map((frame) => frame.fn)).toEqual(["create_order", "create_order_route"]);
      expect(entry.file).toBe("/app/src/shop/orders/service.py");
      expect(entry.lineNumber).toBe(22);
      expect(entry.exceptionType).toBe("AttributeError");
    }
    expect(entries[0]!.message).toBe("POST /api/orders failed\nAttributeError: 'NoneType' object has no attribute 'email'");
    expect(entries[1]!.message).toBe("Exception in ASGI application\nAttributeError: 'NoneType' object has no attribute 'email'");
  });

  it("are swallowed, not skipped, under a dropped INFO line", () => {
    const { entries, skipped } = parseLines(["2026-11-21 20:01:02,345 - server - INFO - handled", ...SIMPLE_TRACEBACK], undefined, undefined, "python");
    expect(entries).toEqual([]);
    expect(skipped).toBe(0);
  });

  it("are dropped together with their line when the log-command bookmark is past it", async () => {
    const folder = mkdtempSync(join(tmpdir(), "vika-python-bookmark-"));
    try {
      const logPath = join(folder, "app.log");
      writeFileSync(
        logPath,
        [
          "2026-11-21 20:00:00,000 - server - ERROR - old failure",
          ...SIMPLE_TRACEBACK,
          "2026-11-21 20:05:00,000 - server - ERROR - new failure",
          ...SIMPLE_TRACEBACK,
          "",
        ].join("\n"),
      );
      const read = await readCommand(`cat ${JSON.stringify(logPath)}`, "2026-11-21T20:00:00.000Z", 5000);
      expect(read.lines).toEqual(["2026-11-21 20:05:00,000 - server - ERROR - new failure", ...SIMPLE_TRACEBACK]);
      expect(read.next).toEqual({ sinceTimestamp: "2026-11-21T20:05:00.000Z" });
      expect(parseLines(read.lines, undefined, undefined, "python").entries).toHaveLength(1);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
