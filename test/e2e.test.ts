// End-to-end test: runs `vika report` against the fixture from
// test/fixture/build.ts, the way a customer would: a vika.yaml in a folder,
// deploys recorded with mark-deploy, logs read from a file, results stored
// in Postgres (TEST_DATABASE_URL), and the report printed as JSON.
import { afterAll, describe, expect, it } from "vitest";
import { reportSchema } from "../src/reporting/report-schema.js";
import type { Report } from "../src/reporting/report-types.js";
import type { Scenario } from "./fixture/build.js";
import { BACKGROUND_ERROR } from "./fixture/build.js";
import { buildReportProject, FIXTURE_SERVICE_NAME, type ReportProject } from "./fixture/build-report-project.js";
import { createFakeJira } from "./fixture/fake-trackers.js";

// All the text in an ADF document, one string per text node.
function collectAdfText(node: unknown): string[] {
  if (node === null || typeof node !== "object") return [];
  const adfNode = node as { type?: string; text?: string; content?: unknown[] };
  return [...(adfNode.type === "text" && adfNode.text !== undefined ? [adfNode.text] : []), ...(adfNode.content ?? []).flatMap(collectAdfText)];
}

const JIRA_TOKEN = "jira-token-E2e5Kq8Zr1";

describe.each<Scenario>(["direct", "indirect"])("vika report --create-tickets on the %s fixture", (scenario) => {
  const projects: ReportProject[] = [];
  afterAll(() => projects.forEach((project) => project.remove()));

  it("files one Jira issue naming the right PR, author and file:line, assigned to the author", async () => {
    const project = await buildReportProject(scenario, {
      trackerYamlLines: ["tracker:", "  type: jira", "  project: OPS"],
      extraEnvironment: { JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "ops@example.com", JIRA_API_TOKEN: JIRA_TOKEN },
    });
    projects.push(project);
    const { expected } = project.fixture;
    const fakeJira = createFakeJira([{ accountId: "acc-tomas", emailAddress: expected.suspectEmail, displayName: expected.suspectAuthor }]);

    const result = await project.runVika(["report", "--create-tickets"], { isInteractive: true, answers: ["y"], fetchFunction: fakeJira.fetchFunction });
    expect(result.errorOutput).not.toMatch(/^vika: /m);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`Assignee:    ${expected.suspectAuthor} <${expected.suspectEmail}> (the suspect's author)`);
    expect(result.output).toContain("Created OPS-1: https://example.atlassian.net/browse/OPS-1");

    expect(fakeJira.issues).toHaveLength(1);
    const { fields } = fakeJira.issues[0]!;
    expect(fields.summary).toBe(`shopfront: 1 error regression after deploy ${expected.badDeploySha.slice(0, 7)} (suspect: PR #${expected.suspectPr})`);
    expect(fields.assignee).toEqual({ accountId: "acc-tomas" });
    expect(fields.labels).toEqual(expect.arrayContaining(["auto-vika", "service-shopfront", `deploy-${expected.badDeploySha.slice(0, 12)}`]));

    const descriptionText = collectAdfText(fields.description).join("\n");
    const expectedLocation = scenario === "direct" ? "src/orders/service.ts:22" : "src/users/repo.ts:16";
    expect(descriptionText).toContain(`PR #${expected.suspectPr}, commit ${expected.suspectSha}, by ${expected.suspectAuthor} <${expected.suspectEmail}>`);
    expect(descriptionText).toContain(`File: ${expectedLocation}`);
    expect(descriptionText).toContain(`Assigned to the suspect's author, ${expected.suspectAuthor} <${expected.suspectEmail}>.`);
    expect(descriptionText).toContain("(log-derived)");
    expect(descriptionText.toLowerCase()).not.toContain("culprit");

    // Secrets: nothing sent to Jira (other than the auth header) holds the
    // token, and the database credentials never appear anywhere.
    const databaseUrl = new URL(project.environment.DATABASE_URL!);
    const everythingSent = JSON.stringify(fakeJira.requests.map((request) => request.body));
    for (const text of [everythingSent, result.output, result.errorOutput]) {
      expect(text).not.toContain(JIRA_TOKEN);
      expect(text).not.toContain(`${databaseUrl.username}:${databaseUrl.password}@`);
    }

    // A second run finds nothing new: no second issue, no comment.
    const secondRun = await project.runVika(["report", "--create-tickets"], { isInteractive: true, answers: ["y"], fetchFunction: fakeJira.fetchFunction });
    expect(secondRun.output).toContain("Already filed as OPS-1, nothing new");
    expect(fakeJira.issues).toHaveLength(1);
    expect(fakeJira.comments).toHaveLength(0);
  }, 60_000);
});

describe.each<Scenario>(["direct", "indirect"])("vika report on the %s fixture", (scenario) => {
  const projects: ReportProject[] = [];
  afterAll(() => projects.forEach((project) => project.remove()));

  it("finds the suspect commit for an error pattern that started after a deploy", async () => {
    const project = await buildReportProject(scenario);
    projects.push(project);
    const { expected } = project.fixture;

    const result = await project.runVika(["report", "--json"]);
    expect(result.errorOutput).not.toMatch(/^vika: /m); // no error line
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.output) as Report;
    expect(report.schemaVersion).toBe(1);
    // The real output matches the documented schema (docs/report-schema.md).
    expect(reportSchema.safeParse(report).error?.issues).toBeUndefined();

    const service = report.services.find((candidate) => candidate.serviceName === FIXTURE_SERVICE_NAME)!;
    // Exactly one regression, on the bad deploy.
    expect(service.regressions).toHaveLength(1);
    const regression = service.regressions[0]!;
    expect(regression.deploySha).toBe(expected.badDeploySha);
    expect(regression.kind).toBe("new");
    expect(regression.firstSeen).toBe(expected.errorFirstSeen);
    // The background DB timeout is steady before and after deploys: never flagged.
    expect(regression.headline).not.toContain(BACKGROUND_ERROR);
    expect(service.regressions.some((candidate) => candidate.headline.includes(BACKGROUND_ERROR))).toBe(false);

    // The right top suspect.
    const topSuspect = regression.suspects[0]!;
    expect(topSuspect).toMatchObject({
      commitSha: expected.suspectSha,
      prNumber: expected.suspectPr,
      confidence: "high",
      author: { name: expected.suspectAuthor, email: expected.suspectEmail },
    });
    const expectedLocation = scenario === "direct" ? { filePath: "src/orders/service.ts", lineText: /order\.discount\.amount/ } : { filePath: "src/users/repo.ts", lineText: /function getUser/ };
    expect(topSuspect.filePath).toBe(expectedLocation.filePath);
    expect(topSuspect.lineNumber).toEqual(expect.any(Number));
    expect(topSuspect.lineText).toMatch(expectedLocation.lineText);

    // The two numbers are there, and say where they come from.
    for (const metrics of [service.metrics, report.metrics]) {
      expect(metrics.changeFailureRate).toMatchObject({ label: "log-derived", value: 0.25, failedDeploys: 1, judgedDeploys: 4 });
      expect(metrics.medianTimeToRestore.label).toBe("log-derived");
      expect(metrics.medianTimeToRestore).toHaveProperty("valueMinutes");
      expect(metrics.ongoingRegressions.label).toBe("log-derived");
    }
  }, 60_000);
});
