// Tests the tracker clients against fake servers: exactly what goes over
// the wire (auth headers, ADF, GraphQL), and the plain-English errors.
// No network, no database.
import { describe, expect, it } from "vitest";
import { createJiraTracker } from "../src/ticket-trackers/jira-tracker.js";
import { createLinearTracker, LINEAR_API_URL } from "../src/ticket-trackers/linear-tracker.js";
import type { FetchFunction } from "../src/ticket-trackers/tracker-types.js";
import type { TicketDraft } from "../src/ticketing/ticket-types.js";
import { createFakeJira, createFakeLinear } from "./fixture/fake-trackers.js";

const JIRA_TOKEN = "jira-token-Q7x9Lm2Pw4";
const LINEAR_KEY = "lin_api_R5t8Vb1Nc3";

const DRAFT: TicketDraft = {
  service: "shopfront",
  deploySha: "f".repeat(40),
  dedupKey: "f".repeat(40),
  title: "shopfront: 1 error regression after deploy fffffff (suspect: PR #812)",
  bodySections: [
    { heading: "Summary", lines: ["Service: shopfront", "Occurrences since the deploy: 124 (log-derived)"] },
    { heading: "Log sources", lines: ["- src/orders/service.ts:22", "- src/api/handlers.ts:16"] },
  ],
  labels: ["auto-vika", "service-shopfront", "deploy-ffffffffffff", "fp-aaaaaaaaaaaa"],
  regressionFingerprints: ["aaaaaaaaaaaa"],
  totalOccurrences: 124,
  suggestedAssignee: { name: "Tomas Ortega", email: "tomas@example.com", source: "author" },
  groups: [],
  assignmentFacts: { topSuspect: null, codeOwners: { emails: [], handles: [] } },
};

const makeJira = (fetchFunction: FetchFunction, timeoutMs?: number) =>
  createJiraTracker({
    baseUrl: "https://example.atlassian.net/",
    email: "ops@example.com",
    apiToken: JIRA_TOKEN,
    projectKey: "OPS",
    fetchFunction,
    secrets: [JIRA_TOKEN],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
const makeLinear = (fetchFunction: FetchFunction) => createLinearTracker({ apiKey: LINEAR_KEY, teamKey: "ENG", fetchFunction, secrets: [LINEAR_KEY] });

describe("Jira", () => {
  it("uses Basic auth, an ADF description, and the accountId from the email lookup", async () => {
    const fakeJira = createFakeJira([{ accountId: "acc-tomas", emailAddress: "tomas@example.com", displayName: "Tomas Ortega" }]);
    const tracker = makeJira(fakeJira.fetchFunction);

    const user = await tracker.findUserByEmail("tomas@example.com");
    expect(user).toEqual({ id: "acc-tomas", name: "Tomas Ortega" });
    expect(await tracker.findUserByEmail("nobody@example.com")).toBeUndefined();
    const issue = await tracker.createIssue(DRAFT, user!.id);
    expect(issue).toEqual({ issueKey: "OPS-1", issueUrl: "https://example.atlassian.net/browse/OPS-1" });

    const expectedAuthorization = `Basic ${Buffer.from(`ops@example.com:${JIRA_TOKEN}`).toString("base64")}`;
    for (const request of fakeJira.requests) expect(request.headers.Authorization).toBe(expectedAuthorization);
    expect(fakeJira.requests[0]!.url).toBe("https://example.atlassian.net/rest/api/3/user/search?query=tomas%40example.com");

    const createRequest = fakeJira.requests.find((request) => request.url.endsWith("/rest/api/3/issue"))!;
    expect(createRequest.body).toEqual({
      fields: {
        project: { key: "OPS" },
        issuetype: { name: "Bug" },
        summary: DRAFT.title,
        labels: DRAFT.labels,
        assignee: { accountId: "acc-tomas" },
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Summary" }] },
            { type: "paragraph", content: [{ type: "text", text: "Service: shopfront" }] },
            { type: "paragraph", content: [{ type: "text", text: "Occurrences since the deploy: 124 (log-derived)" }] },
            { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Log sources" }] },
            {
              type: "bulletList",
              content: [
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "src/orders/service.ts:22" }] }] },
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "src/api/handlers.ts:16" }] }] },
              ],
            },
          ],
        },
      },
    });
  });

  it("finds an issue by label with JQL, and comments in ADF", async () => {
    const fakeJira = createFakeJira();
    const tracker = makeJira(fakeJira.fetchFunction);
    await tracker.createIssue(DRAFT);
    expect(await tracker.findIssueByLabel("deploy-ffffffffffff")).toEqual({ issueKey: "OPS-1", issueUrl: "https://example.atlassian.net/browse/OPS-1" });
    expect(await tracker.findIssueByLabel("deploy-000000000000")).toBeUndefined();
    const searchRequest = fakeJira.requests.find((request) => request.url.endsWith("/rest/api/3/search/jql"))!;
    expect(searchRequest.body).toEqual({ jql: 'project = "OPS" AND labels = "deploy-ffffffffffff" ORDER BY created ASC', fields: ["key"], maxResults: 1 });

    await tracker.addComment("OPS-1", "vika update:\n- a new group");
    expect(fakeJira.comments[0]!.body).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "vika update:" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a new group" }] }] }] },
      ],
    });
  });

  it("turns 401, 404, 429, a timeout and an unreachable host into plain English, never with the token", async () => {
    const tokenEcho = JSON.stringify({ errorMessages: [`token ${JIRA_TOKEN} is invalid`] });
    const cases: [number, string][] = [
      [401, "Jira rejected vika's credentials (HTTP 401). Check JIRA_EMAIL and JIRA_API_TOKEN. (token **** is invalid)"],
      [404, "Jira could not find what vika asked for (HTTP 404)."],
      [429, "Jira is rate-limiting vika (HTTP 429). Nothing was retried; run again in a few minutes."],
    ];
    for (const [httpStatus, expectedMessage] of cases) {
      const tracker = makeJira(createFakeJira([], { failWithStatus: httpStatus, failureBody: tokenEcho }).fetchFunction);
      await expect(tracker.createIssue(DRAFT)).rejects.toThrow(expectedMessage);
      await expect(tracker.createIssue(DRAFT)).rejects.not.toThrow(JIRA_TOKEN);
    }

    // A server that never answers: the request is aborted by the timeout.
    const silentFetch: FetchFunction = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    await expect(makeJira(silentFetch, 50).createIssue(DRAFT)).rejects.toThrow("Jira did not answer within 0.05 seconds. Nothing was retried.");

    const unreachableFetch: FetchFunction = async () => {
      throw new TypeError(`fetch failed for ops@example.com:${JIRA_TOKEN}`);
    };
    const unreachableError = await makeJira(unreachableFetch).createIssue(DRAFT).catch((error: Error) => error.message);
    expect(unreachableError).toMatch(/^could not reach Jira/);
    expect(unreachableError).not.toContain(JIRA_TOKEN);
  });

  it("never retries createIssue", async () => {
    const fakeJira = createFakeJira([], { failWithStatus: 503 });
    await expect(makeJira(fakeJira.fetchFunction).createIssue(DRAFT)).rejects.toThrow("Jira answered with HTTP 503.");
    expect(fakeJira.requests).toHaveLength(1);
  });

  it("uses the configured issue type", async () => {
    const fakeJira = createFakeJira();
    const tracker = createJiraTracker({
      baseUrl: "https://example.atlassian.net",
      email: "ops@example.com",
      apiToken: JIRA_TOKEN,
      projectKey: "OPS",
      issueType: "Task",
      fetchFunction: fakeJira.fetchFunction,
      secrets: [JIRA_TOKEN],
    });
    await tracker.createIssue(DRAFT);
    expect(fakeJira.issues[0]!.fields).toMatchObject({ issuetype: { name: "Task" } });
  });

  it("checks credentials with GET /rest/api/3/myself", async () => {
    const fakeJira = createFakeJira();
    expect(await makeJira(fakeJira.fetchFunction).checkCredentials()).toEqual({ name: "vika bot" });
    expect(fakeJira.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(["GET /rest/api/3/myself"]);
  });
});

describe("Linear", () => {
  it('sends the key with NO "Bearer", as GraphQL, and finds or creates labels by name', async () => {
    const fakeLinear = createFakeLinear([{ id: "user-tomas", email: "tomas@example.com", name: "Tomas Ortega" }], {
      existingLabels: [{ id: "label-existing", name: "auto-vika" }],
    });
    const tracker = makeLinear(fakeLinear.fetchFunction);

    const user = await tracker.findUserByEmail("tomas@example.com");
    expect(user).toEqual({ id: "user-tomas", name: "Tomas Ortega" });
    const issue = await tracker.createIssue(DRAFT, user!.id);
    expect(issue).toEqual({ issueKey: "ENG-1", issueUrl: "https://linear.app/example/issue/ENG-1" });

    for (const request of fakeLinear.requests) {
      expect(request.url).toBe(LINEAR_API_URL);
      expect(request.method).toBe("POST");
      expect(request.headers.Authorization).toBe(LINEAR_KEY);
      expect(Object.keys(request.body as object).sort()).toEqual(["query", "variables"]);
    }
    // "auto-vika" existed; the other three labels were created.
    expect(fakeLinear.labels.map((label) => label.name)).toEqual(["auto-vika", "service-shopfront", "deploy-ffffffffffff", "fp-aaaaaaaaaaaa"]);
    expect(fakeLinear.issues[0]).toMatchObject({
      teamId: "team-1",
      title: DRAFT.title,
      labelIds: ["label-existing", "label-2", "label-3", "label-4"],
      assigneeId: "user-tomas",
      description: "### Summary\n\nService: shopfront\nOccurrences since the deploy: 124 (log-derived)\n\n### Log sources\n\n- src/orders/service.ts:22\n- src/api/handlers.ts:16",
    });
    expect(fakeLinear.issues[0]).not.toHaveProperty("stateId"); // no state: Linear puts it in Backlog

    // A second issue in the same run reuses the cached label ids.
    const labelLookupsBefore = fakeLinear.requests.filter((request) => JSON.stringify(request.body).includes("LabelByName")).length;
    await tracker.createIssue(DRAFT);
    const labelLookupsAfter = fakeLinear.requests.filter((request) => JSON.stringify(request.body).includes("LabelByName")).length;
    expect(labelLookupsAfter).toBe(labelLookupsBefore);
  });

  it("finds an issue by label and comments on it", async () => {
    const fakeLinear = createFakeLinear();
    const tracker = makeLinear(fakeLinear.fetchFunction);
    await tracker.createIssue(DRAFT);
    expect(await tracker.findIssueByLabel("deploy-ffffffffffff")).toEqual({ issueKey: "ENG-1", issueUrl: "https://linear.app/example/issue/ENG-1" });
    await tracker.addComment("ENG-1", "vika update");
    expect(fakeLinear.comments).toEqual([{ issueId: "issue-1", body: "vika update" }]);
  });

  it("turns HTTP and GraphQL failures into plain English, never with the key", async () => {
    const unauthorized = makeLinear(createFakeLinear([], { failWithStatus: 401, failureBody: `bad key ${LINEAR_KEY}` }).fetchFunction);
    const unauthorizedMessage = await unauthorized.findUserByEmail("tomas@example.com").catch((error: Error) => error.message);
    expect(unauthorizedMessage).toContain("Linear rejected vika's credentials (HTTP 401). Check LINEAR_API_KEY.");
    expect(unauthorizedMessage).not.toContain(LINEAR_KEY);

    const rateLimited = makeLinear(createFakeLinear([], { graphqlErrorCode: "RATELIMITED" }).fetchFunction);
    await expect(rateLimited.findUserByEmail("tomas@example.com")).rejects.toThrow("Linear is rate-limiting vika. Nothing was retried");
  });
});
