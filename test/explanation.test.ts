// Tests the optional AI step, `vika report --explain`: the vika.yaml switch,
// doctor's line, the request text (what is sent and what never is), the
// read-only diff reader, the approval questions, the API errors, and that
// vika's own ranking never changes. Every AI call goes to a fake fetch.
// The end-to-end part needs TEST_DATABASE_URL.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveAndExplain, EXPLAIN_QUESTION, NO_TERMINAL_MESSAGE } from "../src/commands/approve-and-explain.js";
import { runExplainCommand } from "../src/commands/explain-command.js";
import { runCli } from "../src/commands/run-cli.js";
import { ConfigurationError } from "../src/configuration/configuration-errors.js";
import { loadConfiguration, type LoadedConfiguration } from "../src/configuration/load-configuration.js";
import { checkExplanation } from "../src/doctor/check-explanation.js";
import { ANTHROPIC_API_VERSION, ANTHROPIC_MESSAGES_URL, askLlm } from "../src/explanation/ask-llm.js";
import { buildExplanationRequest, MAX_REQUEST_CHARACTERS } from "../src/explanation/build-explanation-request.js";
import { EXPLAIN_KEY_MISSING_MESSAGE, EXPLAIN_TURNED_OFF_MESSAGE } from "../src/explanation/check-explain-allowed.js";
import type { ExplanationRequestInput } from "../src/explanation/explanation-types.js";
import { findPossibleSecret } from "../src/explanation/find-possible-secret.js";
import type { PreparedExplanation } from "../src/explanation/prepare-explanation-requests.js";
import { readSuspectDiffs } from "../src/explanation/read-suspect-diffs.js";
import { EXPLANATION_SYSTEM_PROMPT } from "../src/explanation/system-prompt.js";
import { reportSchema } from "../src/reporting/report-schema.js";
import { AI_OPINION_HEADING } from "../src/reporting/format-terminal-report.js";
import type { Report } from "../src/reporting/report-types.js";
import type { Suspect } from "../src/suspect-attribution/suspect-types.js";
import { buildFixture, type Fixture } from "./fixture/build.js";
import { buildReportProject, FIXTURE_SERVICE_NAME, type ReportProject } from "./fixture/build-report-project.js";
import { createFakeAnthropic, FAKE_ANSWER_TEXT } from "./fixture/fake-anthropic.js";
import { createFakeLinear, createForbiddenFetch } from "./fixture/fake-trackers.js";

// Never a real key: the real .env may hold one, and no test may use it.
const API_KEY = "sk-ant-test-Exp1a1nKey9Qw3Rt";
const LINEAR_KEY = "lin_api_Expl4Zq8Wm2";
const UNREACHABLE_DATABASE_URL = "postgres://vika:Unreach4ble-Pass@127.0.0.1:1/vika";
const MINIMAL_SERVICES_YAML = ["services:", "  api:", "    repo: ./no-such-repo", "    logs: /var/log/api.log", ""].join("\n");
const ENABLED_YAML_LINES = ["explain:", "  enabled: true"];

const temporaryFolders: string[] = [];
afterAll(() => temporaryFolders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

function makeProjectFolder(yamlText: string): string {
  const folder = mkdtempSync(join(tmpdir(), "vika-explain-"));
  temporaryFolders.push(folder);
  writeFileSync(join(folder, "vika.yaml"), yamlText);
  return folder;
}

function loadFromYaml(yamlText: string, environment: Record<string, string> = {}): LoadedConfiguration {
  return loadConfiguration({ workingDirectory: makeProjectFolder(yamlText), environment: { DATABASE_URL: UNREACHABLE_DATABASE_URL, ...environment } });
}

function readYamlProblems(yamlText: string): string[] {
  try {
    loadFromYaml(yamlText);
  } catch (error) {
    if (error instanceof ConfigurationError) return error.problems;
    throw error;
  }
  return [];
}

// Runs `vika` with output captured; the network is a fetch that fails the test.
async function runVikaInFolder(folder: string, argumentList: string[], environment: Record<string, string>, fetchFunction = createForbiddenFetch([])) {
  let output = "";
  let errorOutput = "";
  const exitCode = await runCli(argumentList, {
    writeOutput: (text) => (output += text),
    writeError: (text) => (errorOutput += text),
    isOutputTerminal: true,
    isInputTerminal: true,
    ask: async () => "y",
    fetchFunction,
    environment,
    workingDirectory: folder,
    clock: () => new Date("2026-03-11T00:00:00.000Z"),
  });
  return { exitCode, output, errorOutput };
}

function makeSuspect(overrides: Partial<Suspect> = {}): Suspect {
  return {
    commitSha: "a".repeat(40),
    prNumber: 812,
    confidence: "high",
    evidenceKind: "call-chain-function-changed",
    reason: "changed getUser, which createOrder calls",
    filePath: "src/users/repo.ts",
    lineNumber: 5,
    lineText: "export function getUser(id: string): User | null {",
    author: { name: "Tomas Novak", email: "tomas@example.com" },
    isInDeployRange: true,
    isBot: false,
    ...overrides,
  };
}

function makeRequestInput(overrides: Partial<ExplanationRequestInput> = {}): ExplanationRequestInput {
  return {
    regression: {
      exceptionType: "TypeError",
      message: "TypeError: Cannot read properties of null (reading 'email')",
      topFrames: [
        { filePath: "src/orders/service.ts", lineNumber: 12, functionName: "createOrder" },
        { filePath: "src/api/handlers.ts", lineNumber: 8, functionName: "handleCreateOrder" },
      ],
    },
    suspects: [makeSuspect()],
    suspectDiffs: [{ commitSha: "a".repeat(40), diffText: "commit aaaa\nsubject: Return null from getUser\n\n-  throw new Error()\n+  return null;\n", problem: null }],
    maxDiffLines: 200,
    redactionKinds: ["email", "jwt", "ip", "cardlike"],
    secrets: [],
    ...overrides,
  };
}

describe("explain settings in vika.yaml", () => {
  it("are off by default, and the API key is not even read", () => {
    const configuration = loadFromYaml(MINIMAL_SERVICES_YAML, { ANTHROPIC_API_KEY: API_KEY });
    expect(configuration.explain).toEqual({ isEnabled: false, provider: "anthropic", model: "claude-sonnet-5-5", maxDiffLines: 200, apiKey: null });
  });

  it("read the key from the environment only when enabled", () => {
    const yamlText = `${MINIMAL_SERVICES_YAML}explain:\n  enabled: true\n  model: claude-opus-5-5\n  maxDiffLines: 50\n`;
    expect(loadFromYaml(yamlText, { ANTHROPIC_API_KEY: API_KEY }).explain).toEqual({
      isEnabled: true,
      provider: "anthropic",
      model: "claude-opus-5-5",
      maxDiffLines: 50,
      apiKey: API_KEY,
    });
    // Missing key: vika.yaml still loads (only --explain and doctor care).
    expect(loadFromYaml(yamlText).explain.apiKey).toBeNull();
  });

  it("reject an unknown provider, an unknown key, and a key written in vika.yaml", () => {
    expect(readYamlProblems(`${MINIMAL_SERVICES_YAML}explain:\n  provider: openai\n`).join("\n")).toMatch(/explain\.provider must be one of "anthropic"/);
    expect(readYamlProblems(`${MINIMAL_SERVICES_YAML}explain:\n  enabled: true\n  temperature: 0\n`).join("\n")).toMatch(/temperature/);
    expect(readYamlProblems(`${MINIMAL_SERVICES_YAML}explain:\n  apiKey: ${API_KEY}\n`).join("\n")).toMatch(/put it in \.env as ANTHROPIC_API_KEY/);
  });

  it("enforce maxDiffLines between 20 and 1000", () => {
    expect(readYamlProblems(`${MINIMAL_SERVICES_YAML}explain:\n  maxDiffLines: 19\n`).join("\n")).toMatch(/at least 20/);
    expect(readYamlProblems(`${MINIMAL_SERVICES_YAML}explain:\n  maxDiffLines: 1001\n`).join("\n")).toMatch(/at most 1000/);
    expect(readYamlProblems(`${MINIMAL_SERVICES_YAML}explain:\n  maxDiffLines: 20\n`)).toEqual([]);
    expect(readYamlProblems(`${MINIMAL_SERVICES_YAML}explain:\n  maxDiffLines: 1000\n`)).toEqual([]);
  });

  it("the API key is hidden when the configuration is printed or masked", async () => {
    const { describeConfigurationSafely } = await import("../src/configuration/describe-configuration-safely.js");
    const { collectSecrets, hideSecrets } = await import("../src/configuration/hide-secrets.js");
    const configuration = loadFromYaml(`${MINIMAL_SERVICES_YAML}explain:\n  enabled: true\n`, { ANTHROPIC_API_KEY: API_KEY });
    expect(JSON.stringify(describeConfigurationSafely(configuration))).not.toContain(API_KEY);
    expect(hideSecrets(`bad key ${API_KEY}`, collectSecrets(configuration))).toBe("bad key ****");
  });
});

describe("vika report --explain is blocked before any other work", () => {
  // The database URL points nowhere and the repo does not exist: if vika got
  // as far as reading logs, git or the database, the error would be different.
  it("with no explain block: the turned-off message, nothing read, nothing sent", async () => {
    const networkCalls: string[] = [];
    const folder = makeProjectFolder(MINIMAL_SERVICES_YAML);
    const result = await runVikaInFolder(folder, ["report", "--explain"], { DATABASE_URL: UNREACHABLE_DATABASE_URL, ANTHROPIC_API_KEY: API_KEY }, createForbiddenFetch(networkCalls));
    expect(result.exitCode).toBe(1);
    expect(result.errorOutput).toBe(`vika: ${EXPLAIN_TURNED_OFF_MESSAGE}\n`);
    expect(result.output).toBe("");
    expect(networkCalls).toEqual([]);
  });

  it("with enabled: false: the same", async () => {
    const networkCalls: string[] = [];
    const folder = makeProjectFolder(`${MINIMAL_SERVICES_YAML}explain:\n  enabled: false\n`);
    const result = await runVikaInFolder(folder, ["report", "--explain", "--json"], { DATABASE_URL: UNREACHABLE_DATABASE_URL, ANTHROPIC_API_KEY: API_KEY }, createForbiddenFetch(networkCalls));
    expect(result.errorOutput).toBe(`vika: ${EXPLAIN_TURNED_OFF_MESSAGE}\n`);
    expect(networkCalls).toEqual([]);
  });

  it("enabled without ANTHROPIC_API_KEY: says so, nothing sent", async () => {
    const networkCalls: string[] = [];
    const folder = makeProjectFolder(`${MINIMAL_SERVICES_YAML}explain:\n  enabled: true\n`);
    const result = await runVikaInFolder(folder, ["report", "--explain"], { DATABASE_URL: UNREACHABLE_DATABASE_URL }, createForbiddenFetch(networkCalls));
    expect(result.errorOutput).toBe(`vika: ${EXPLAIN_KEY_MISSING_MESSAGE}\n`);
    expect(networkCalls).toEqual([]);
  });

  it("`vika run` has no --explain at all", async () => {
    const networkCalls: string[] = [];
    const folder = makeProjectFolder(`${MINIMAL_SERVICES_YAML}explain:\n  enabled: true\n`);
    const result = await runVikaInFolder(folder, ["run", "--explain"], { DATABASE_URL: UNREACHABLE_DATABASE_URL, ANTHROPIC_API_KEY: API_KEY }, createForbiddenFetch(networkCalls));
    expect(result.exitCode).not.toBe(0);
    expect(result.errorOutput).toMatch(/unknown option '--explain'/);
    expect(networkCalls).toEqual([]);
  });
});

describe("doctor's AI explanations line", () => {
  const explainSettings = (overrides: Partial<LoadedConfiguration["explain"]>): LoadedConfiguration["explain"] => ({
    isEnabled: false,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    maxDiffLines: 200,
    apiKey: null,
    ...overrides,
  });

  it("off, on with a key, on without a key (FAIL)", () => {
    expect(checkExplanation(explainSettings({}))).toEqual([{ area: "explain", level: "OK", message: "AI explanations: off", fix: null }]);
    expect(checkExplanation(explainSettings({ isEnabled: true, apiKey: API_KEY }))).toEqual([
      { area: "explain", level: "OK", message: "AI explanations: on (model claude-sonnet-5-5)", fix: null },
    ]);
    const [failed] = checkExplanation(explainSettings({ isEnabled: true }));
    expect(failed).toMatchObject({ level: "FAIL", message: "AI explanations: on (model claude-sonnet-5-5), but ANTHROPIC_API_KEY is not set" });
    expect(failed!.fix).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("never calls fetch, and never prints the key", async () => {
    const networkCalls: string[] = [];
    const folder = makeProjectFolder(`${MINIMAL_SERVICES_YAML}explain:\n  enabled: true\n`);
    const result = await runVikaInFolder(folder, ["doctor"], { DATABASE_URL: UNREACHABLE_DATABASE_URL, ANTHROPIC_API_KEY: API_KEY }, createForbiddenFetch(networkCalls));
    expect(result.output).toContain("OK   explain: AI explanations: on (model claude-sonnet-5-5)");
    expect(result.output + result.errorOutput).not.toContain(API_KEY);
    expect(networkCalls).toEqual([]);

    const withoutKey = await runVikaInFolder(folder, ["doctor"], { DATABASE_URL: UNREACHABLE_DATABASE_URL }, createForbiddenFetch(networkCalls));
    expect(withoutKey.output).toContain("FAIL explain: AI explanations: on (model claude-sonnet-5-5), but ANTHROPIC_API_KEY is not set");
    expect(withoutKey.exitCode).toBe(1);
    expect(networkCalls).toEqual([]);
  }, 30_000);
});

describe("buildExplanationRequest", () => {
  it("holds the error, the frames and the suspects, and nothing about the author", () => {
    const { promptText, leftOutNotes } = buildExplanationRequest(makeRequestInput());
    expect(promptText).toContain("Type: TypeError");
    expect(promptText).toContain("Message: TypeError: Cannot read properties of null (reading 'email')");
    expect(promptText).toContain("1. createOrder at src/orders/service.ts:12");
    expect(promptText).toContain("2. handleCreateOrder at src/api/handlers.ts:8");
    expect(promptText).toContain(`Suspect 1: commit ${"a".repeat(40)} (PR #812)`);
    expect(promptText).toContain("Evidence: call-chain-function-changed, confidence high");
    expect(promptText).toContain("+  return null;");
    expect(promptText).not.toContain("Tomas Novak");
    expect(promptText).not.toContain("tomas@example.com");
    expect(leftOutNotes).toEqual([]);
  });

  it("never holds an email, a token, an IP or a known secret, even with redact: [cardlike]", () => {
    const leakyText = "user ana@shop.example from 203.0.113.9 sent Bearer abc.def.ghi and eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl with SuperSecretDbPass";
    const { promptText } = buildExplanationRequest(
      makeRequestInput({
        regression: { exceptionType: "Error", message: leakyText, topFrames: [] },
        suspects: [makeSuspect({ reason: leakyText, lineText: leakyText })],
        suspectDiffs: [{ commitSha: "a".repeat(40), diffText: `+ log("${leakyText}")\n`, problem: null }],
        redactionKinds: ["cardlike"],
        secrets: ["SuperSecretDbPass"],
      }),
    );
    expect(promptText).not.toMatch(/ana@shop\.example|203\.0\.113\.9|abc\.def\.ghi|eyJhbGciOi|SuperSecretDbPass/);
    expect(promptText).toContain("<email>");
    expect(promptText).toContain("<ip>");
    expect(promptText).toContain("<token>");
  });

  it("only sends the top 3 suspects", () => {
    const suspects = ["1", "2", "3", "4"].map((digit) => makeSuspect({ commitSha: digit.repeat(40) }));
    const { promptText } = buildExplanationRequest(makeRequestInput({ suspects, suspectDiffs: [] }));
    expect(promptText).toContain("Suspect 3:");
    expect(promptText).not.toContain("Suspect 4:");
    expect(promptText).not.toContain("4".repeat(40));
  });

  it("cuts each diff to maxDiffLines with a visible note", () => {
    const diffText = Array.from({ length: 360 }, (_unused, lineIndex) => `+ line ${lineIndex}`).join("\n");
    const { promptText } = buildExplanationRequest(
      makeRequestInput({ maxDiffLines: 20, suspectDiffs: [{ commitSha: "a".repeat(40), diffText, problem: null }] }),
    );
    expect(promptText).toContain("+ line 19");
    expect(promptText).not.toContain("+ line 20\n");
    expect(promptText).toContain("[diff cut: 340 more lines]");
  });

  it("keeps the whole message under about 6000 tokens", () => {
    const hugeDiff = Array.from({ length: 1000 }, (_unused, lineIndex) => `+ const value${lineIndex} = computeSomethingLong(${lineIndex}, "padding padding padding");`).join("\n");
    const suspects = ["1", "2", "3"].map((digit) => makeSuspect({ commitSha: digit.repeat(40) }));
    const suspectDiffs = suspects.map((suspect) => ({ commitSha: suspect.commitSha, diffText: hugeDiff, problem: null }));
    const { promptText } = buildExplanationRequest(makeRequestInput({ maxDiffLines: 1000, suspects, suspectDiffs }));
    expect(promptText.length).toBeLessThanOrEqual(MAX_REQUEST_CHARACTERS);
    // Every suspect still gets part of its diff, each with its own cut note.
    expect(promptText.match(/\[diff cut: \d+ more lines\]/g)).toHaveLength(3);
  });

  it("leaves out a diff that looks like it holds a secret, and says so", () => {
    for (const secretLine of [
      `+ const key = "sk-live-${"x".repeat(24)}";`,
      "+ AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "+ -----BEGIN RSA PRIVATE KEY-----",
      `+ token: ghp_${"a".repeat(36)}`,
      "+ password = 'hunter2hunter2hunter2'",
    ]) {
      expect(findPossibleSecret(secretLine), secretLine).not.toBeNull();
      const { promptText, leftOutNotes } = buildExplanationRequest(
        makeRequestInput({ suspectDiffs: [{ commitSha: "a".repeat(40), diffText: `+ fine line\n${secretLine}\n`, problem: null }] }),
      );
      expect(promptText).not.toContain(secretLine.slice(2));
      expect(promptText).not.toContain("+ fine line");
      expect(promptText).toContain("[diff left out: possible secret");
      expect(leftOutNotes[0]).toMatch(/^Suspect 1 \(commit aaaaaaa\): diff left out: possible secret/);
    }
    expect(findPossibleSecret("+ return getUser(id) ?? null;")).toBeNull();
  });
});

describe("askLlm", () => {
  const ask = (fetchFunction: Parameters<typeof askLlm>[0]["fetchFunction"], timeoutMs?: number) =>
    askLlm({
      model: "claude-sonnet-5-5",
      systemPrompt: EXPLANATION_SYSTEM_PROMPT,
      promptText: "the message",
      apiKey: API_KEY,
      fetchFunction,
      secrets: [],
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });

  it("sends one Messages API request and returns the answer text", async () => {
    const fake = createFakeAnthropic();
    expect(await ask(fake.fetchFunction)).toEqual({ status: "answered", answerText: FAKE_ANSWER_TEXT });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request!.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(request!.headers).toMatchObject({ "x-api-key": API_KEY, "anthropic-version": ANTHROPIC_API_VERSION, "content-type": "application/json" });
    expect(request!.body).toMatchObject({ model: "claude-sonnet-5-5", system: EXPLANATION_SYSTEM_PROMPT, messages: [{ role: "user", content: "the message" }] });
    expect(request!.body).not.toHaveProperty("temperature");
  });

  it.each([
    [401, /rejected the API key \(HTTP 401\)\. Check ANTHROPIC_API_KEY/],
    [404, /does not know the model "claude-sonnet-5-5" \(HTTP 404\)\. Check explain\.model in vika\.yaml/],
    [429, /rate-limiting this key \(HTTP 429\)\. Nothing was retried/],
    [500, /answered with HTTP 500\. Nothing was retried/],
  ])("HTTP %i gives a plain message without the key, and is not retried", async (httpStatus, expectedMessage) => {
    // The provider echoes the key back: it must still never be shown.
    const fake = createFakeAnthropic({ httpStatus, errorMessage: `problem with key ${API_KEY}` });
    const result = await ask(fake.fetchFunction);
    expect(result.status).toBe("failed");
    const message = (result as { message: string }).message;
    expect(message).toMatch(expectedMessage);
    expect(message).not.toContain(API_KEY);
    expect(fake.requests).toHaveLength(1);
  });

  it("a timeout gives a plain message, once", async () => {
    const fake = createFakeAnthropic({ isHanging: true });
    const result = await ask(fake.fetchFunction, 50);
    expect(result).toEqual({ status: "failed", message: "The AI provider did not answer within 0.05 seconds. Nothing was retried." });
    expect(fake.requests).toHaveLength(1);
  });

  it("a network error never shows the key", async () => {
    const result = await ask(async () => {
      throw new Error(`connect failed for ${API_KEY}`);
    });
    expect((result as { message: string }).message).not.toContain(API_KEY);
  });
});

describe("approving each AI request", () => {
  const prepared: PreparedExplanation[] = [
    { serviceName: "shopfront", regressionIndex: 0, request: { promptText: "message one\n", leftOutNotes: ["Suspect 2 (commit bbbbbbb): diff left out: possible secret (an AWS access key)"] } },
  ];
  const makeConsole = (answers: string[], isInteractive = true) => {
    const written: string[] = [];
    const questions: string[] = [];
    return {
      written,
      questions,
      explainConsole: {
        isInteractive,
        write: (text: string) => written.push(text),
        ask: async (question: string) => {
          questions.push(question);
          return answers.shift() ?? "";
        },
      },
    };
  };

  it("y sends exactly once, after showing the exact text", async () => {
    const { written, questions, explainConsole } = makeConsole(["y"]);
    const sent: PreparedExplanation[] = [];
    const results = await approveAndExplain(prepared, "claude-sonnet-5-5", explainConsole, async (request) => {
      sent.push(request);
      return { status: "answered", answerText: "answer" };
    });
    expect(sent).toHaveLength(1);
    expect(questions).toEqual([EXPLAIN_QUESTION]);
    const shown = written.join("");
    expect(shown).toContain(EXPLANATION_SYSTEM_PROMPT);
    expect(shown).toContain("message one");
    expect(shown).toContain("diff left out: possible secret");
    expect(results).toEqual([{ serviceName: "shopfront", regressionIndex: 0, explanation: { model: "claude-sonnet-5-5", answerText: "answer" } }]);
  });

  it.each(["n", "", "yes please", "Y "])("anything but y (%j) sends nothing", async (answer) => {
    const { explainConsole } = makeConsole([answer]);
    let sendCount = 0;
    const results = await approveAndExplain(prepared, "claude-sonnet-5-5", explainConsole, async () => {
      sendCount += 1;
      return { status: "answered", answerText: "answer" };
    });
    // "Y " is "y" once trimmed and lowercased; everything else is a no.
    expect(sendCount).toBe(answer === "Y " ? 1 : 0);
    if (answer !== "Y ") expect(results[0]!.explanation).toBeNull();
  });

  it("no terminal: nothing is read, nothing is sent, and it says why", async () => {
    const { written, questions, explainConsole } = makeConsole([], false);
    const networkCalls: string[] = [];
    let diffReadCount = 0;
    const configuration = loadFromYaml(`${MINIMAL_SERVICES_YAML}explain:\n  enabled: true\n`, { ANTHROPIC_API_KEY: API_KEY });
    const report: Report = { schemaVersion: 1, asOf: null, services: [], metrics: { changeFailureRate: { label: "log-derived", value: null, failedDeploys: 0, judgedDeploys: 0, note: "not enough data" }, medianTimeToRestore: { label: "log-derived", valueMinutes: null, restoredRegressions: 0, note: "not enough data" }, ongoingRegressions: { label: "log-derived", value: 0 } } };
    await runExplainCommand({
      configuration,
      report,
      serviceInputs: [],
      fetchFunction: createForbiddenFetch(networkCalls),
      explainConsole,
      readDiffs: async () => {
        diffReadCount += 1;
        return [];
      },
    });
    expect(written.join("")).toContain(NO_TERMINAL_MESSAGE);
    expect(questions).toEqual([]);
    expect(diffReadCount).toBe(0);
    expect(networkCalls).toEqual([]);
  });
});

describe("readSuspectDiffs on the indirect fixture", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = buildFixture("indirect");
  }, 60_000);
  afterAll(() => rmSync(fixture.root, { recursive: true, force: true }));

  const gitOutput = (gitArguments: string[]) => execFileSync("git", gitArguments, { cwd: fixture.repoDir, encoding: "utf8" });
  const suspectOfFixture = () =>
    makeSuspect({ commitSha: fixture.expected.suspectSha, prNumber: fixture.expected.suspectPr, filePath: "src/users/repo.ts" });

  it("reads the getUser() commit diff, and the request includes it", async () => {
    const suspectDiffs = await readSuspectDiffs({
      repoPath: fixture.repoDir,
      suspects: [suspectOfFixture()],
      stackTraceFilePaths: ["src/orders/service.ts", "src/api/handlers.ts"],
    });
    expect(suspectDiffs).toHaveLength(1);
    expect(suspectDiffs[0]!.diffText).toContain("export function getUser(id: string): User | null {");
    expect(suspectDiffs[0]!.diffText).not.toContain(fixture.expected.suspectEmail);
    const { promptText } = buildExplanationRequest(makeRequestInput({ suspects: [suspectOfFixture()], suspectDiffs }));
    expect(promptText).toContain("export function getUser(id: string): User | null {");
  });

  it("is read-only: HEAD, refs and git status are unchanged", async () => {
    const before = [gitOutput(["rev-parse", "HEAD"]), gitOutput(["for-each-ref"]), gitOutput(["status", "--porcelain", "--ignored"])];
    await readSuspectDiffs({ repoPath: fixture.repoDir, suspects: [suspectOfFixture()], stackTraceFilePaths: ["src/orders/service.ts"] });
    const after = [gitOutput(["rev-parse", "HEAD"]), gitOutput(["for-each-ref"]), gitOutput(["status", "--porcelain", "--ignored"])];
    expect(after).toEqual(before);
  });

  it('refuses a ref or a path that starts with "-"', async () => {
    await expect(readSuspectDiffs({ repoPath: fixture.repoDir, suspects: [makeSuspect({ commitSha: "--output=/tmp/x" })], stackTraceFilePaths: [] })).rejects.toThrow(/invalid commit/);
    await expect(readSuspectDiffs({ repoPath: fixture.repoDir, suspects: [suspectOfFixture()], stackTraceFilePaths: ["--output=/tmp/x"] })).rejects.toThrow(/invalid path/);
  });
});

describe("vika report --explain on the indirect fixture", () => {
  const projects: ReportProject[] = [];
  afterAll(() => projects.forEach((project) => project.remove()));

  const startProject = async () => {
    const project = await buildReportProject("indirect", {
      trackerYamlLines: ["tracker:", "  type: linear", "  team: ENG"],
      extraEnvironment: { LINEAR_API_KEY: LINEAR_KEY, ANTHROPIC_API_KEY: API_KEY },
      explainYamlLines: ENABLED_YAML_LINES,
    });
    projects.push(project);
    return project;
  };

  // The terminal report with the AI block taken out.
  const withoutAiBlock = (output: string) => {
    const lines = output.split("\n");
    const keptLines: string[] = [];
    let isInAiBlock = false;
    for (const line of lines) {
      if (line.trim() === AI_OPINION_HEADING) isInAiBlock = true;
      else if (isInAiBlock && !line.startsWith("       ")) isInAiBlock = false;
      if (!isInAiBlock) keptLines.push(line);
    }
    return keptLines.join("\n");
  };

  it("y: sends once with the getUser() diff; JSON gets the explanation; the ranking is unchanged", async () => {
    const project = await startProject();
    const plain = await project.runVika(["report", "--json"], { fetchFunction: createFakeLinear().fetchFunction });
    const plainReport = JSON.parse(plain.output) as Report;
    expect(JSON.stringify(plainReport)).not.toContain('"explanation"');

    const fake = createFakeAnthropic();
    const explained = await project.runVika(["report", "--json", "--explain"], { isInteractive: true, answers: ["y"], fetchFunction: fake.fetchFunction });
    expect(explained.exitCode).toBe(0);
    expect(explained.questions).toEqual([EXPLAIN_QUESTION]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body.messages[0]!.content).toContain("export function getUser(id: string): User | null {");

    const explainedReport = JSON.parse(explained.output) as Report;
    expect(reportSchema.safeParse(explainedReport).error?.issues).toBeUndefined();
    const plainRegression = plainReport.services.find((service) => service.serviceName === FIXTURE_SERVICE_NAME)!.regressions[0]!;
    const explainedRegression = explainedReport.services.find((service) => service.serviceName === FIXTURE_SERVICE_NAME)!.regressions[0]!;
    expect(explainedRegression.explanation).toEqual({ model: "claude-sonnet-5-5", answerText: FAKE_ANSWER_TEXT });
    const { explanation: _explanation, ...explainedWithoutAnswer } = explainedRegression;
    expect(explainedWithoutAnswer).toEqual(plainRegression);
    // Nothing about the request or the answer was stored.
    const stored = await project.runVika(["report", "--json"], { fetchFunction: createForbiddenFetch([]) });
    expect(stored.output).not.toContain(FAKE_ANSWER_TEXT);
  }, 120_000);

  it("terminal report: identical outside the AI block", async () => {
    const project = await startProject();
    const plain = await project.runVika(["report"], { isInteractive: true });
    const fake = createFakeAnthropic();
    const explained = await project.runVika(["report", "--explain"], { isInteractive: true, answers: ["y"], fetchFunction: fake.fetchFunction });
    expect(explained.output).toContain(AI_OPINION_HEADING);
    expect(explained.output).toContain(FAKE_ANSWER_TEXT);
    const reportPart = (output: string) => output.slice(output.indexOf("vika report - as of"));
    expect(withoutAiBlock(reportPart(explained.output))).toBe(reportPart(plain.output));
  }, 120_000);

  it("n sends nothing; no terminal sends nothing; `vika run` never sends", async () => {
    const project = await startProject();
    const declined = createFakeAnthropic();
    const declinedResult = await project.runVika(["report", "--explain"], { isInteractive: true, answers: ["n"], fetchFunction: declined.fetchFunction });
    expect(declined.requests).toHaveLength(0);
    expect(declinedResult.output).toContain("none (nothing was sent, or the request failed)");

    const noTerminal = createFakeAnthropic();
    const noTerminalResult = await project.runVika(["report", "--explain", "--json"], { isInteractive: false, fetchFunction: noTerminal.fetchFunction });
    expect(noTerminal.requests).toHaveLength(0);
    expect(noTerminalResult.errorOutput).toContain(NO_TERMINAL_MESSAGE);
    expect((JSON.parse(noTerminalResult.output) as Report).services[0]!.regressions[0]!.explanation).toBeNull();

    const cron = createFakeAnthropic();
    await project.runVika(["run"], { isInteractive: true, answers: ["y"], fetchFunction: cron.fetchFunction });
    expect(cron.requests).toHaveLength(0);
  }, 120_000);

  it("never prints the database password, the tracker token or the API key", async () => {
    const project = await startProject();
    // The provider echoes the key in its error; vika must still hide it.
    const fake = createFakeAnthropic({ httpStatus: 401, errorMessage: `invalid x-api-key ${API_KEY} for ${LINEAR_KEY}` });
    const result = await project.runVika(["report", "--explain"], { isInteractive: true, answers: ["y"], fetchFunction: fake.fetchFunction });
    const everything = result.output + result.errorOutput;
    expect(everything).toContain("rejected the API key (HTTP 401)");
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain(LINEAR_KEY);
    expect(everything).not.toContain(project.environment.DATABASE_URL);
    const databasePassword = decodeURIComponent(new URL(project.environment.DATABASE_URL!).password);
    if (databasePassword.length >= 6) expect(everything).not.toContain(databasePassword);
    // The message sent to the AI holds none of them either.
    const sentText = JSON.stringify(fake.requests[0]!.body);
    for (const secret of [API_KEY, LINEAR_KEY, project.environment.DATABASE_URL!]) expect(sentText).not.toContain(secret);
  }, 120_000);
});
