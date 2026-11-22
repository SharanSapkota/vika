// Tests the `regression.detected` webhook: the payload (no email, valid,
// stable id), the signature, the URL rules, and that `vika run` sends each
// regression once, survives failures and timeouts, and retries on the next
// run. Fake fetch only; needs TEST_DATABASE_URL.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReportCommand } from "../src/commands/report-command.js";
import { ConfigurationError } from "../src/configuration/configuration-errors.js";
import { loadConfiguration } from "../src/configuration/load-configuration.js";
import { openStore } from "../src/database/database-store.js";
import type { ReportRegression } from "../src/reporting/report-types.js";
import type { FetchFunction } from "../src/ticket-trackers/tracker-types.js";
import { buildWebhookPayload, makeEventId } from "../src/webhook/build-webhook-payload.js";
import { sendRegressionWebhooks } from "../src/webhook/send-regression-webhooks.js";
import { isWebhookSignatureValid, signWebhookBody } from "../src/webhook/sign-webhook-body.js";
import { webhookPayloadSchema } from "../src/webhook/webhook-payload-schema.js";
import { buildFixture, type Fixture } from "./fixture/build.js";
import { buildReportProject, readTestDatabaseUrl, type ReportProject } from "./fixture/build-report-project.js";

const WEBHOOK_URL = "https://hooks.example.com/services/T0K3N-in-the-path";
const WEBHOOK_SECRET = "whsec-Wh7Kq2Lp9";
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/;

interface PostedWebhook {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// A webhook receiver that records every post and answers with the given status.
function makeReceiver(httpStatus = 200): { fetchFunction: FetchFunction; posts: PostedWebhook[] } {
  const posts: PostedWebhook[] = [];
  return {
    posts,
    fetchFunction: async (url, init) => {
      posts.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
      return new Response("ok", { status: httpStatus });
    },
  };
}

const REGRESSION: ReportRegression = {
  fingerprint: "ccd7664d4f99",
  kind: "new",
  severity: "high",
  headline: "TypeError: Cannot read properties of undefined (reading 'amount')",
  exceptionType: "TypeError",
  deploySha: "f".repeat(40),
  deployTime: "2026-03-06T14:00:00.000Z",
  firstSeen: "2026-03-06T14:04:07.312Z",
  occurrences: 124,
  baselineRatePerHour: 0,
  postDeployRatePerHour: 1.8,
  isAmbiguous: false,
  restoredAt: null,
  suspects: [
    {
      commitSha: "b".repeat(40),
      prNumber: 812,
      confidence: "high",
      evidenceKind: "blamed-line-changed",
      reason: "Line 22 of src/orders/service.ts, where the error is thrown, was last changed by this commit.",
      filePath: "src/orders/service.ts",
      lineNumber: 22,
      lineText: "  const total = order.discount.amount;",
      author: { name: "Tomas Ortega", email: "tomas@example.com" },
      isInDeployRange: true,
      isBot: false,
    },
  ],
  suspectMessage: null,
};

describe("webhook payload and signature", () => {
  it("is valid, names the author without an email, and carries no log text", () => {
    const payload = buildWebhookPayload("shopfront", REGRESSION);
    expect(webhookPayloadSchema.safeParse(payload).error?.issues).toBeUndefined();
    expect(payload.suspect).toEqual({ commitSha: "b".repeat(40), prNumber: 812, confidence: "high", authorName: "Tomas Ortega" });
    expect(payload.label).toBe("log-derived");
    const body = JSON.stringify(payload);
    expect(body).not.toMatch(EMAIL_PATTERN);
    expect(body).not.toContain("Cannot read properties"); // no log text
    expect(buildWebhookPayload("shopfront", { ...REGRESSION, suspects: [] }).suspect).toBeNull();
  });

  it("gives the same regression the same eventId, and different ones different ids", () => {
    expect(makeEventId("shopfront", "f".repeat(40), "ccd7664d4f99")).toBe(makeEventId("shopfront", "f".repeat(40), "ccd7664d4f99"));
    expect(makeEventId("shopfront", "f".repeat(40), "ccd7664d4f99")).not.toBe(makeEventId("shopfront", "f".repeat(40), "000000000000"));
  });

  it("signs the exact body with HMAC-SHA256; any change breaks the signature", () => {
    const body = JSON.stringify(buildWebhookPayload("shopfront", REGRESSION));
    const signature = signWebhookBody(body, WEBHOOK_SECRET);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(isWebhookSignatureValid(body, WEBHOOK_SECRET, signature)).toBe(true);
    expect(isWebhookSignatureValid(body.replace("812", "813"), WEBHOOK_SECRET, signature)).toBe(false);
    expect(isWebhookSignatureValid(body, "another-secret", signature)).toBe(false);
  });
});

describe("webhook settings", () => {
  const folders: string[] = [];
  afterAll(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));
  const loadWithWebhook = (webhookLines: string[], environment: Record<string, string> = {}) => {
    const folder = mkdtempSync(join(tmpdir(), "vika-webhook-"));
    folders.push(folder);
    writeFileSync(join(folder, "vika.yaml"), ["services:", "  api:", "    repo: .", "    logs: app.log", ...webhookLines, ""].join("\n"));
    return loadConfiguration({ workingDirectory: folder, environment: { DATABASE_URL: "postgres://vika:vika@localhost:5433/vika", ...environment } });
  };
  const readProblems = (webhookLines: string[]) => {
    try {
      loadWithWebhook(webhookLines);
    } catch (error) {
      if (error instanceof ConfigurationError) return error.problems;
      throw error;
    }
    throw new Error("expected loading to fail");
  };

  it("allows https anywhere and plain http only for localhost", () => {
    expect(loadWithWebhook(["webhook:", `  url: ${WEBHOOK_URL}`], { VIKA_WEBHOOK_SECRET: WEBHOOK_SECRET }).webhook).toEqual({ url: WEBHOOK_URL, secret: WEBHOOK_SECRET });
    expect(loadWithWebhook(["webhook:", "  url: http://localhost:9000/hook"]).webhook).toEqual({ url: "http://localhost:9000/hook", secret: null });
    expect(loadWithWebhook(["webhook:", "  url: http://127.0.0.1:9000/hook"]).webhook?.url).toBe("http://127.0.0.1:9000/hook");
    expect(readProblems(["webhook:", "  url: http://hooks.example.com/vika"])).toEqual(["webhook.url must use https (plain http is only allowed for localhost)"]);
    expect(readProblems(["webhook:", "  url: hooks.example.com"])).toEqual(["webhook.url must be a full URL, like https://hooks.example.com/vika"]);
  });

  it("refuses a secret in vika.yaml: it belongs in .env", () => {
    expect(readProblems(["webhook:", `  url: ${WEBHOOK_URL}`, "  secret: hunter2"])).toEqual([
      "webhook.secret must not be in vika.yaml: put it in .env as VIKA_WEBHOOK_SECRET",
    ]);
  });
});

describe("vika run and the webhook", () => {
  let fixture: Fixture;
  const projects: ReportProject[] = [];
  beforeAll(() => {
    fixture = buildFixture("direct");
  }, 60_000);
  afterAll(() => {
    projects.forEach((project) => project.remove());
    rmSync(fixture.root, { recursive: true, force: true });
  });
  const startProject = async () => {
    const project = await buildReportProject("direct", {
      fixture,
      trackerYamlLines: ["webhook:", `  url: ${WEBHOOK_URL}`],
      extraEnvironment: { VIKA_WEBHOOK_SECRET: WEBHOOK_SECRET },
    });
    projects.push(project);
    return project;
  };

  it("sends each regression once across two runs, signed, valid, without an email", async () => {
    const project = await startProject();
    const receiver = makeReceiver();
    const firstRun = await project.runVika(["run"], { fetchFunction: receiver.fetchFunction });
    const secondRun = await project.runVika(["run"], { fetchFunction: receiver.fetchFunction });
    expect([firstRun.exitCode, secondRun.exitCode]).toEqual([0, 0]);
    expect(firstRun.output).toContain("Webhook: posted 1 new regression");
    expect(secondRun.output).not.toContain("Webhook: posted");
    expect(receiver.posts).toHaveLength(1);

    const [post] = receiver.posts;
    expect(post!.url).toBe(WEBHOOK_URL);
    expect(post!.headers["X-Vika-Event"]).toBe("regression.detected");
    expect(isWebhookSignatureValid(post!.body, WEBHOOK_SECRET, post!.headers["X-Vika-Signature"]!)).toBe(true);
    const payload = webhookPayloadSchema.parse(JSON.parse(post!.body));
    expect(payload).toMatchObject({ service: "shopfront", deploySha: fixture.expected.badDeploySha, severity: "high", suspect: { prNumber: 812, authorName: "Tomas Ortega" } });
    expect(post!.body).not.toMatch(EMAIL_PATTERN);
  }, 60_000);

  it("a failed delivery warns, never fails the run, and is retried on the next run only", async () => {
    const project = await startProject();
    const failingReceiver = makeReceiver(500);
    const failedRun = await project.runVika(["run"], { fetchFunction: failingReceiver.fetchFunction });
    expect(failedRun.exitCode).toBe(0);
    expect(failedRun.output).toContain("Warning: webhook at hooks.example.com answered with HTTP 500 for shopfront deploy");
    expect(failedRun.output).toContain("vika will try again on the next run");
    expect(failedRun.output).not.toContain("T0K3N"); // the URL's path can hold a token
    expect(failingReceiver.posts).toHaveLength(1); // no retry loop

    const workingReceiver = makeReceiver();
    await project.runVika(["run"], { fetchFunction: workingReceiver.fetchFunction });
    await project.runVika(["run"], { fetchFunction: workingReceiver.fetchFunction });
    expect(workingReceiver.posts).toHaveLength(1);
  }, 60_000);

  it("a receiver that never answers times out with a warning, and nothing throws", async () => {
    const project = await startProject();
    const { report } = await runReportCommand({ workingDirectory: project.folder, environment: project.environment, storeOptions: project.storeOptions });
    const store = await openStore(readTestDatabaseUrl(), project.storeOptions);
    try {
      const silentReceiver: FetchFunction = (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      const result = await sendRegressionWebhooks({ store, webhook: { url: WEBHOOK_URL, secret: null }, report, fetchFunction: silentReceiver, timeoutMs: 50 });
      expect(result.deliveredCount).toBe(0);
      expect(result.warnings).toEqual([expect.stringContaining("webhook at hooks.example.com did not answer within 0.05 seconds")]);
    } finally {
      await store.close();
    }
  }, 60_000);

  it("`vika report` never sends the webhook (only `vika run` does)", async () => {
    const project = await startProject();
    const receiver = makeReceiver();
    expect((await project.runVika(["report"], { fetchFunction: receiver.fetchFunction })).exitCode).toBe(0);
    expect(receiver.posts).toEqual([]);
  }, 60_000);
});
