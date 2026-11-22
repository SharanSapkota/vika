// Tests ticket drafting and filing: one draft per bad deploy, the assignee
// rules, CODEOWNERS, and create-ticket's dedup guarantees (with a real
// Postgres schema and a fake tracker). No network. Needs TEST_DATABASE_URL.
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { openStore } from "../src/database/database-store.js";
import type { Store, StoredCluster } from "../src/database/store-types.js";
import type { ReportRegression } from "../src/reporting/report-types.js";
import type { Suspect } from "../src/suspect-attribution/suspect-types.js";
import { createJiraTracker } from "../src/ticket-trackers/jira-tracker.js";
import { buildTicketDraft, describeAssignment, makeDeployLabel } from "../src/ticketing/build-ticket-draft.js";
import { chooseAssignee } from "../src/ticketing/choose-assignee.js";
import { createTicket } from "../src/ticketing/create-ticket.js";
import { findCodeOwners, parseCodeOwners, readCodeOwnersForFile } from "../src/ticketing/read-code-owners.js";
import { renderMarkdown } from "../src/ticketing/render-ticket-text.js";
import type { CodeOwners, TicketDraft } from "../src/ticketing/ticket-types.js";
import { makeTestSchemaName, readTestDatabaseUrl } from "./fixture/build-report-project.js";
import { buildSmallRepo, type SmallRepo } from "./fixture/build-small-repo.js";
import { createFakeJira, type FakeJira } from "./fixture/fake-trackers.js";

const DEPLOY_SHA = "f".repeat(40);
const JIRA_TOKEN = "jira-token-Q7x9Lm2Pw4";
const NO_OWNERS: CodeOwners = { emails: [], handles: [] };

function makeSuspect(overrides: Partial<Suspect> = {}): Suspect {
  return {
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
    ...overrides,
  };
}

function makeRegression(fingerprint: string, overrides: Partial<ReportRegression> = {}): ReportRegression {
  return {
    fingerprint,
    kind: "new",
    severity: "high",
    headline: `TypeError in group ${fingerprint}`,
    exceptionType: "TypeError",
    deploySha: DEPLOY_SHA,
    deployTime: "2026-03-06T14:00:00.000Z",
    firstSeen: "2026-03-06T14:04:07.312Z",
    occurrences: 100,
    baselineRatePerHour: 0,
    postDeployRatePerHour: 1.8,
    isAmbiguous: false,
    restoredAt: null,
    suspects: [makeSuspect()],
    suspectMessage: null,
    ...overrides,
  };
}

function makeCluster(fingerprint: string): StoredCluster {
  return {
    service: "shopfront",
    fingerprint,
    normalizerVersion: 1,
    template: "TypeError",
    exceptionType: "TypeError",
    topFrames: [],
    examples: ["POST /api/orders failed user=u_1 ip=<ip>\nTypeError: Cannot read properties of undefined", "second example", "third example", "fourth example"],
    sourceRefs: ["/app/src/orders/service.ts:22"],
    firstSeen: "2026-03-06T14:04:07.312Z",
    lastSeen: "2026-03-10T23:50:00.000Z",
  };
}

function makeDraft(regressions: ReportRegression[], codeOwners: CodeOwners = NO_OWNERS): TicketDraft {
  const draft = buildTicketDraft({
    serviceName: "shopfront",
    deploySha: DEPLOY_SHA,
    deployTime: "2026-03-06T14:00:00.000Z",
    regressions,
    clusters: regressions.map((regression) => makeCluster(regression.fingerprint)),
    codeOwners,
  });
  if (draft === undefined) throw new Error("expected a draft");
  return draft;
}

describe("buildTicketDraft", () => {
  it("puts two regressions on one deploy into ONE draft", () => {
    const draft = makeDraft([makeRegression("aaaaaaaaaaaa", { occurrences: 100 }), makeRegression("bbbbbbbbbbbb", { occurrences: 30, severity: "medium" })]);
    expect(draft.dedupKey).toBe(DEPLOY_SHA);
    expect(draft.regressionFingerprints).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    expect(draft.totalOccurrences).toBe(130);
    expect(draft.labels).toEqual(["auto-vika", "service-shopfront", `deploy-${DEPLOY_SHA.slice(0, 12)}`, "fp-aaaaaaaaaaaa", "fp-bbbbbbbbbbbb"]);
    expect(draft.title).toBe("shopfront: 2 error regressions after deploy fffffff (suspect: PR #812)");
    // The same commit suspected in both groups is listed once.
    expect(draft.bodySections.find((section) => section.heading === "Also changed in this deploy")).toBeUndefined();

    const markdown = renderMarkdown(draft.bodySections);
    expect(markdown).toContain("Occurrences since the deploy: 130 (log-derived)");
    expect(markdown).toContain("- /app/src/orders/service.ts:22");
    expect(markdown).toContain("Confidence: high (evidence: blamed-line-changed)");
    expect(markdown).toContain("Why: Line 22 of src/orders/service.ts");
    // At most 3 examples per group, each on one line.
    expect(markdown).toContain("- POST /api/orders failed user=u_1 ip=<ip> | TypeError: Cannot read properties of undefined");
    expect(markdown).not.toContain("fourth example");
    expect(markdown.toLowerCase()).not.toContain("culprit");
  });

  it("leaves low-severity groups out, with a count line, and files nothing if only low ones remain", () => {
    const draft = makeDraft([
      makeRegression("aaaaaaaaaaaa"),
      makeRegression("cccccccccccc", { severity: "low" }),
      makeRegression("dddddddddddd", { severity: "low" }),
    ]);
    expect(draft.regressionFingerprints).toEqual(["aaaaaaaaaaaa"]);
    expect(draft.labels).not.toContain("fp-cccccccccccc");
    expect(renderMarkdown(draft.bodySections)).toContain("2 low-severity groups not listed");

    const onlyLow = buildTicketDraft({
      serviceName: "shopfront",
      deploySha: DEPLOY_SHA,
      deployTime: null,
      regressions: [makeRegression("cccccccccccc", { severity: "low" })],
      clusters: [],
      codeOwners: NO_OWNERS,
    });
    expect(onlyLow).toBeUndefined();
  });

  it('lists the other suspects under "Also changed in this deploy", 5 suspects at most', () => {
    const otherSuspects = [1, 2, 3, 4, 5, 6].map((suspectNumber) =>
      makeSuspect({ commitSha: String(suspectNumber).repeat(40), prNumber: 900 + suspectNumber, confidence: "medium", evidenceKind: "file-changed" }),
    );
    const draft = makeDraft([makeRegression("aaaaaaaaaaaa", { suspects: [makeSuspect(), ...otherSuspects.slice(0, 3)] }), makeRegression("bbbbbbbbbbbb", { suspects: otherSuspects.slice(2) })]);
    const alsoChanged = draft.bodySections.find((section) => section.heading === "Also changed in this deploy")!;
    expect(alsoChanged.lines).toHaveLength(4); // top suspect + 4 others = 5
    expect(alsoChanged.lines[0]).toMatch(/^- PR #901, commit 1{40} by Tomas Ortega/);
  });
});

describe("chooseAssignee", () => {
  const isKnown = (knownEmails: string[]) => (email: string) => knownEmails.includes(email);

  it("assigns the author when the tracker knows their email", () => {
    expect(chooseAssignee({ topSuspect: makeSuspect(), codeOwnerEmails: ["owner@example.com"], isTrackerUser: isKnown(["tomas@example.com", "owner@example.com"]) })).toEqual({
      name: "Tomas Ortega",
      email: "tomas@example.com",
      source: "author",
    });
  });

  it("falls back to a CODEOWNERS email for a bot author", () => {
    const botSuspect = makeSuspect({ author: { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" }, isBot: true });
    expect(chooseAssignee({ topSuspect: botSuspect, codeOwnerEmails: ["owner@example.com"], isTrackerUser: () => true })).toEqual({ name: null, email: "owner@example.com", source: "codeowners" });
  });

  it("falls back to a CODEOWNERS email for a noreply author email", () => {
    const noReplySuspect = makeSuspect({ author: { name: "Tomas Ortega", email: "1234+tomas@users.noreply.github.com" } });
    expect(chooseAssignee({ topSuspect: noReplySuspect, codeOwnerEmails: ["owner@example.com"], isTrackerUser: () => true }).source).toBe("codeowners");
  });

  it("falls back to a CODEOWNERS email when the tracker doesn't know the author", () => {
    expect(chooseAssignee({ topSuspect: makeSuspect(), codeOwnerEmails: ["owner@example.com"], isTrackerUser: isKnown(["owner@example.com"])}).source).toBe("codeowners");
  });

  it("with only GitHub handles as owners: unassigned, handles and author name in the description", () => {
    const codeOwners: CodeOwners = { emails: [], handles: ["@alice", "@shop/backend"] };
    const assignee = chooseAssignee({ topSuspect: makeSuspect(), codeOwnerEmails: codeOwners.emails, isTrackerUser: isKnown([]) });
    expect(assignee).toEqual({ name: "Tomas Ortega", email: null, source: "none" });
    const assignmentLines = describeAssignment(assignee, { topSuspect: makeSuspect(), codeOwners }).lines.join("\n");
    expect(assignmentLines).toContain("Unassigned");
    expect(assignmentLines).toContain("The suspect's author is Tomas Ortega");
    expect(assignmentLines).toContain("Code owners: @alice, @shop/backend");
  });
});

describe("CODEOWNERS", () => {
  const repos: SmallRepo[] = [];
  afterAll(() => repos.forEach((repo) => rmSync(repo.root, { recursive: true, force: true })));
  const author = { name: "Alice Novak", email: "alice@example.com" };

  it("matches like GitHub: the last matching pattern wins", () => {
    const rules = parseCodeOwners(
      [
        "# Everything else",
        "*                    fallback@example.com",
        "*.ts                 @ts-team",
        "/build/              build@example.com",
        "docs/*               @docs-team",
        "apps/**/payments     payments@example.com @alice",
        "src/orders/          orders@example.com @shop/backend # orders squad",
        "src/orders/legacy.ts",
      ].join("\n"),
    );
    expect(findCodeOwners(rules, "README.md")).toEqual({ emails: ["fallback@example.com"], handles: [] });
    expect(findCodeOwners(rules, "src/users/repo.ts")).toEqual({ emails: [], handles: ["@ts-team"] });
    expect(findCodeOwners(rules, "src/orders/service.ts")).toEqual({ emails: ["orders@example.com"], handles: ["@shop/backend"] });
    expect(findCodeOwners(rules, "build/output.js")).toEqual({ emails: ["build@example.com"], handles: [] });
    expect(findCodeOwners(rules, "lib/build/output.js")).toEqual({ emails: ["fallback@example.com"], handles: [] }); // "/build/" is anchored
    expect(findCodeOwners(rules, "docs/guide.md")).toEqual({ emails: [], handles: ["@docs-team"] });
    expect(findCodeOwners(rules, "apps/web/v2/payments/client.ts")).toEqual({ emails: ["payments@example.com"], handles: ["@alice"] });
    expect(findCodeOwners(rules, "src/orders/legacy.ts")).toEqual(NO_OWNERS); // matched, but nobody owns it
  });

  it("reads CODEOWNERS from .github/, the root or docs/ (in that order), at the deployed sha", async () => {
    const repo = buildSmallRepo();
    repos.push(repo);
    const docsSha = repo.commit({ "docs/CODEOWNERS": "* docs-owner@example.com\n", "src/a.ts": "a\n" }, { message: "docs owners", author, time: "2026-04-01T09:00:00Z" });
    const rootSha = repo.commit({ CODEOWNERS: "* root-owner@example.com\n" }, { message: "root owners", author, time: "2026-04-02T09:00:00Z" });
    const githubSha = repo.commit({ ".github/CODEOWNERS": "* github-owner@example.com\n" }, { message: "github owners", author, time: "2026-04-03T09:00:00Z" });
    repo.commit({ ".github/CODEOWNERS": "* newer-owner@example.com\n" }, { message: "change owners", author, time: "2026-04-04T09:00:00Z" });

    expect((await readCodeOwnersForFile(repo.repoPath, docsSha, "src/a.ts")).emails).toEqual(["docs-owner@example.com"]);
    expect((await readCodeOwnersForFile(repo.repoPath, rootSha, "src/a.ts")).emails).toEqual(["root-owner@example.com"]);
    expect((await readCodeOwnersForFile(repo.repoPath, githubSha, "src/a.ts")).emails).toEqual(["github-owner@example.com"]);
  });

  it("gives no owners when the repo has no CODEOWNERS", async () => {
    const repo = buildSmallRepo();
    repos.push(repo);
    const sha = repo.commit({ "src/a.ts": "a\n" }, { message: "no owners", author, time: "2026-04-01T09:00:00Z" });
    expect(await readCodeOwnersForFile(repo.repoPath, sha, "src/a.ts")).toEqual(NO_OWNERS);
  });
});

describe("createTicket", () => {
  const stores: Store[] = [];
  afterAll(async () => {
    for (const store of stores) await store.close();
  });
  const openTestStore = async (schema = makeTestSchemaName()) => {
    const store = await openStore(readTestDatabaseUrl(), { schema });
    stores.push(store);
    return store;
  };
  const makeJira = (fakeJira: FakeJira) =>
    createJiraTracker({ baseUrl: "https://example.atlassian.net", email: "ops@example.com", apiToken: JIRA_TOKEN, projectKey: "OPS", fetchFunction: fakeJira.fetchFunction, secrets: [JIRA_TOKEN] });
  const TOMAS = { accountId: "acc-tomas", emailAddress: "tomas@example.com", displayName: "Tomas Ortega" };

  it("files once; a second run files nothing; a new group later adds one comment, not a second ticket", async () => {
    const store = await openTestStore();
    const fakeJira = createFakeJira([TOMAS]);
    const tracker = makeJira(fakeJira);
    const firstDraft = makeDraft([makeRegression("aaaaaaaaaaaa")]);

    const firstRun = await createTicket({ store, tracker, draft: firstDraft, secrets: [JIRA_TOKEN] });
    expect(firstRun).toMatchObject({ status: "created", issueKey: "OPS-1", assignee: { source: "author", email: "tomas@example.com" } });
    expect(fakeJira.issues[0]!.fields.assignee).toEqual({ accountId: "acc-tomas" });

    const secondRun = await createTicket({ store, tracker, draft: firstDraft, secrets: [JIRA_TOKEN] });
    expect(secondRun).toMatchObject({ status: "already filed", issueKey: "OPS-1" });

    const laterDraft = makeDraft([makeRegression("aaaaaaaaaaaa"), makeRegression("bbbbbbbbbbbb", { headline: "RangeError: late group", occurrences: 7, severity: "medium" })]);
    const laterRun = await createTicket({ store, tracker, draft: laterDraft, secrets: [JIRA_TOKEN] });
    expect(laterRun).toMatchObject({ status: "commented", issueKey: "OPS-1", newFingerprints: ["bbbbbbbbbbbb"] });

    expect(fakeJira.issues).toHaveLength(1);
    expect(fakeJira.comments).toHaveLength(1);
    expect(JSON.stringify(fakeJira.comments[0]!.body)).toContain("RangeError: late group");
    expect(await store.findTicket("shopfront", DEPLOY_SHA)).toMatchObject({ fingerprints: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], lastKnownCount: 107 });
  });

  it("comments on a growing count only once it has at least doubled since the last comment", async () => {
    const store = await openTestStore();
    const fakeJira = createFakeJira([TOMAS]);
    const tracker = makeJira(fakeJira);
    const fileWithCount = (occurrences: number) =>
      createTicket({ store, tracker, draft: makeDraft([makeRegression("aaaaaaaaaaaa", { occurrences })]), secrets: [] });

    expect(await fileWithCount(100)).toMatchObject({ status: "created" });
    expect(await fileWithCount(150)).toMatchObject({ status: "already filed" }); // grew, but not double
    expect(await fileWithCount(199)).toMatchObject({ status: "already filed" });
    expect(await store.findTicket("shopfront", DEPLOY_SHA)).toMatchObject({ lastKnownCount: 199, lastCommentedCount: 100 });
    expect(await fileWithCount(200)).toMatchObject({ status: "commented", newFingerprints: [] }); // double of 100
    expect(await fileWithCount(399)).toMatchObject({ status: "already filed" }); // not double of 200
    expect(await fileWithCount(400)).toMatchObject({ status: "commented" });

    expect(fakeJira.comments).toHaveLength(2);
    expect(JSON.stringify(fakeJira.comments[0]!.body)).toContain("Occurrences since the deploy: 200 (was 100 when vika last wrote to this ticket)");
    expect(await store.findTicket("shopfront", DEPLOY_SHA)).toMatchObject({ lastKnownCount: 400, lastCommentedCount: 400 });
  });

  it("vika's database wiped, but the deploy label is in the tracker: no duplicate", async () => {
    const fakeJira = createFakeJira([TOMAS], {
      existingIssues: [{ key: "OPS-41", fields: { summary: "filed before the wipe", labels: ["auto-vika", makeDeployLabel(DEPLOY_SHA)], description: {} } }],
    });
    const freshStore = await openTestStore();
    const outcome = await createTicket({ store: freshStore, tracker: makeJira(fakeJira), draft: makeDraft([makeRegression("aaaaaaaaaaaa")]), secrets: [] });
    expect(outcome).toMatchObject({ status: "found in tracker", issueKey: "OPS-41" });
    expect(fakeJira.issues).toHaveLength(1);
    expect(await freshStore.findTicket("shopfront", DEPLOY_SHA)).toMatchObject({ issueKey: "OPS-41" });
  });

  it("two overlapping runs file one issue", async () => {
    const schema = makeTestSchemaName();
    const [firstStore, secondStore] = [await openTestStore(schema), await openTestStore(schema)];
    const fakeJira = createFakeJira([TOMAS], { createDelayMs: 300 });
    const tracker = makeJira(fakeJira);
    const draft = makeDraft([makeRegression("aaaaaaaaaaaa")]);
    const outcomes = await Promise.all([
      createTicket({ store: firstStore, tracker, draft, secrets: [] }),
      createTicket({ store: secondStore, tracker, draft, secrets: [] }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["busy", "created"]);
    expect(fakeJira.issues).toHaveLength(1);
  });

  it('tracker type "none" gives a clean message', async () => {
    const outcome = await createTicket({ store: await openTestStore(), tracker: null, draft: makeDraft([makeRegression("aaaaaaaaaaaa")]), secrets: [] });
    expect(outcome).toEqual({ status: "no tracker configured", message: 'tracker.type is "none" in vika.yaml, so no ticket was filed' });
  });

  it("401 and 429 give plain messages that never contain the token", async () => {
    for (const [httpStatus, expectedText] of [
      [401, "Jira rejected vika's credentials (HTTP 401). Check JIRA_EMAIL and JIRA_API_TOKEN."],
      [429, "Jira is rate-limiting vika (HTTP 429). Nothing was retried"],
    ] as const) {
      // The fake server echoes the token back, like a careless proxy might.
      const fakeJira = createFakeJira([TOMAS], { failWithStatus: httpStatus, failureBody: JSON.stringify({ errorMessages: [`bad token ${JIRA_TOKEN}`] }) });
      const outcome = await createTicket({ store: await openTestStore(), tracker: makeJira(fakeJira), draft: makeDraft([makeRegression("aaaaaaaaaaaa")]), secrets: [JIRA_TOKEN] });
      expect(outcome.status).toBe("failed");
      const message = (outcome as { message: string }).message;
      expect(message).toContain(expectedText);
      expect(message).not.toContain(JIRA_TOKEN);
    }
  });
});
